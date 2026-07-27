// sources/podiuminfo.mjs
//
// ARCHITECTURE (rewritten after Podiuminfo's 24 July 2026 relaunch):
//
// The old approach searched per-artist via ?input_zoek=<artist>. We
// verified directly (fetching that exact URL) that the server now IGNORES
// this query param entirely and just returns the generic, unfiltered
// agenda — the relaunch moved free-text search to client-side JavaScript.
// This explained a cluster of earlier bugs (missing real matches, huge
// numbers of unrelated "candidates" for popular artist names) — none of
// it was ever really filtered by artist at all.
//
// The new approach crawls Podiuminfo's per-DAY agenda pages instead:
//   https://www.podiuminfo.nl/concertagenda/YYYY/MM/DD/
// These are still plain server-rendered pages (confirmed working), and
// each one is unambiguous — every event on it belongs to exactly that one
// date, so there's no cross-day date-parsing ambiguity like the old
// listing-climbing approach had.
//
// Flow:
//   1. For each day in the lookahead window, fetch that day's agenda page
//      (cached — see dayCacheEntries) and extract every event's concert id
//      + a COARSE lineup guess from the anchor's title attribute
//      ("Concert X in Y" — same reliable prefix format as before).
//   2. Check that coarse lineup against ALL tracked artist names (cheap,
//      in-memory, no network cost — this is the big win: cost no longer
//      scales with how many artists you track).
//   3. Only for actual coarse matches, fetch that concert's OWN page
//      (cached — concertCacheEntries) and parse its authoritative <title>
//      tag for confirmed lineup/venue/city/date, exactly as before.
//
// This keeps every correctness guarantee from before (authoritative
// per-page data, exact matching, concert-id dedup) while cutting total
// requests from "per artist" to "per day + per actual match".

import * as cheerio from "cheerio";

const MONTHS = {
  januari: "01", februari: "02", maart: "03", april: "04", mei: "05", juni: "06",
  juli: "07", augustus: "08", september: "09", oktober: "10", november: "11", december: "12",
};

function splitLineup(title) {
  const cleaned = title.replace(/^Concert\s+/i, "");
  const parts = cleaned
    .split(/\s*(?:\+|•|\/)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [cleaned.trim()];
}

function isArtistMatch(candidate, wanted) {
  const norm = (s) => s.toLowerCase().trim().replace(/\s+/g, " ");
  return norm(candidate) === norm(wanted);
}

const MIN_GAP_MS = 1200;
let lastRequestAt = 0;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttledFetch(url) {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (listening-mirror discovery bot; personal use)" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchPage(url, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const res = await throttledFetch(url);
    if (res.ok) return res.text();

    if (res.status === 429 && attempt < retries) {
      const retryAfterHeader = Number(res.headers.get("retry-after"));
      const backoffMs = retryAfterHeader > 0 ? retryAfterHeader * 1000 : 3000 * 2 ** attempt;
      console.warn(`Podiuminfo 429, backing off ${backoffMs}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(backoffMs);
      continue;
    }
    throw new Error(`Podiuminfo request failed: ${res.status} ${url}`);
  }
}

// ---------- Day agenda pages (candidate discovery) ----------

function buildDayUrl(dateStr) {
  const [year, month, day] = dateStr.split("-");
  return `https://www.podiuminfo.nl/concertagenda/${year}/${month}/${day}/`;
}

function findCandidatesOnDayPage(html) {
  const $ = cheerio.load(html);
  const candidates = new Map(); // concertId -> { href, lineup }

  $('a[href*="/concert/"]').each((_, node) => {
    const $a = $(node);
    const href = $a.attr("href") || "";
    const m = href.match(/\/concert\/(\d+)\/([^/]+)\/?/);
    if (!m) return;
    const [, concertId] = m;

    const titleAttr = $a.attr("title") || "";
    const tm = titleAttr.match(/^Concert\s+(.+?)\s+in\s+/i);
    if (!tm) return;

    if (!candidates.has(concertId)) {
      candidates.set(concertId, { href, lineup: splitLineup(tm[1]) });
    }
  });

  return candidates;
}

const DAY_CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours

async function getDayCandidates(dateStr, dayCacheEntries) {
  const cached = dayCacheEntries[dateStr];
  if (cached && Date.now() - new Date(cached.checkedAt).getTime() < DAY_CACHE_MAX_AGE_MS) {
    return new Map(cached.candidates.map((c) => [c.concertId, { href: c.href, lineup: c.lineup }]));
  }

  const html = await fetchPage(buildDayUrl(dateStr));
  const candidates = findCandidatesOnDayPage(html);

  dayCacheEntries[dateStr] = {
    checkedAt: new Date().toISOString(),
    candidates: [...candidates.entries()].map(([concertId, v]) => ({ concertId, href: v.href, lineup: v.lineup })),
  };

  return candidates;
}

// ---------- Individual concert pages (authoritative data) ----------

// Expected <title>: "Concert {Artist(s)} in {Venue}, {City} op {weekday} {day} {month} {year}"
function parseConcertPageTitle(html) {
  const $ = cheerio.load(html);
  const titleText = ($("head title").first().text() || $("title").first().text() || "").trim();

  const m = titleText.match(
    /^Concert\s+(.+?)\s+in\s+(.+?)\s+op\s+\S+\s+(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})/i
  );
  if (!m) return null;

  const [, lineupRaw, venueCityRaw, day, monthName, year] = m;

  const lastComma = venueCityRaw.lastIndexOf(",");
  let venue = venueCityRaw.trim();
  let city = null;
  if (lastComma !== -1) {
    venue = venueCityRaw.slice(0, lastComma).trim();
    city = venueCityRaw.slice(lastComma + 1).trim();
  }

  const date = `${year}-${MONTHS[monthName.toLowerCase()]}-${day.padStart(2, "0")}`;

  const image = $('meta[property="og:image"]').attr("content") || null;
  const ticketHref = $('a[href*="/ticket/"]').first().attr("href") || null;

  return {
    lineup: splitLineup(lineupRaw.trim()),
    venue,
    city,
    date,
    image,
    ticketUrl: ticketHref ? (ticketHref.startsWith("http") ? ticketHref : `https://www.podiuminfo.nl${ticketHref}`) : null,
  };
}

const CONCERT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function discoverEvents({ trackedArtistNames, startDate, endDate, dayCacheEntries, concertCacheEntries }) {
  const trackedSet = new Set(trackedArtistNames.map((n) => n.toLowerCase().trim()));
  const toOpen = new Map(); // concertId -> href

  const cursor = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    try {
      const candidates = await getDayCandidates(dateStr, dayCacheEntries);
      for (const [concertId, { href, lineup }] of candidates.entries()) {
        const isRelevant = lineup.some((name) => trackedSet.has(name.toLowerCase().trim()));
        if (isRelevant && !toOpen.has(concertId)) {
          toOpen.set(concertId, href);
        }
      }
    } catch (err) {
      console.warn(`Skipping day ${dateStr}: ${err.message}`);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  console.log(`Day crawl found ${toOpen.size} candidate concerts matching tracked artists.`);

  const events = [];
  for (const [concertId, href] of toOpen.entries()) {
    const cached = concertCacheEntries[concertId];
    let parsed;

    if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CONCERT_CACHE_MAX_AGE_MS) {
      parsed = cached;
    } else {
      const url = href.startsWith("http") ? href : `https://www.podiuminfo.nl${href}`;
      let html;
      try {
        html = await fetchPage(url);
      } catch (err) {
        console.warn(`Failed to fetch concert page ${url}: ${err.message}`);
        continue;
      }
      parsed = parseConcertPageTitle(html);
      if (!parsed) continue;
      parsed.url = url;
      parsed.cachedAt = new Date().toISOString();
      concertCacheEntries[concertId] = parsed;
    }

    const matchedTracked = parsed.lineup.filter((name) => trackedSet.has(name.toLowerCase().trim()));
    if (matchedTracked.length === 0) continue;

    events.push({ concertId, ...parsed, matchedTracked });
  }

  return events;
}

export async function queryPodiuminfoForArtists(trackedArtistNames, { startDate, endDate, dayCacheEntries, concertCacheEntries }) {
  const events = await discoverEvents({ trackedArtistNames, startDate, endDate, dayCacheEntries, concertCacheEntries });

  const results = [];
  for (const e of events) {
    if (!e.date) continue;
    for (const mainArtist of e.matchedTracked) {
      const supporting = e.lineup.filter((name) => name !== mainArtist);
      results.push({
        artist: mainArtist,
        supportingArtists: supporting,
        date: e.date,
        time: null,
        venue: e.venue,
        city: e.city || "Unknown",
        country: "NL",
        ticketUrl: e.ticketUrl,
        image: e.image,
        source: "podiuminfo",
        podiuminfoUrl: e.url,
      });
    }
  }
  return results;
}