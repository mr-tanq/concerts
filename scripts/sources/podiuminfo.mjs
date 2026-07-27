// sources/podiuminfo.mjs
//
// ARCHITECTURE (unchanged since the 24 July 2026 Podiuminfo relaunch):
//   Phase 1 — crawl per-DAY agenda pages (/concertagenda/YYYY/MM/DD/) to
//             find candidate concert ids. Free-text search (?input_zoek=)
//             is dead: the server ignores it and returns the generic
//             agenda, so it can never be trusted again.
//   Phase 2 — fetch each candidate concert's OWN page and parse its
//             <title> for the authoritative lineup/venue/city/date.
//
// Correctness rules that must not regress:
//   - the day-listing is only a coarse pre-filter; the concert page is the
//     single source of truth for date/venue/city/lineup
//   - artist matching is EXACT (normalized), never substring/fuzzy
//   - the Podiuminfo concert id is the canonical identity for dedup
//   - supporting artists are preserved
//
// Resilience rules:
//   - a failed day request is NEVER treated as "no concerts that day".
//     If we hold a cached entry we serve it and flag it stale; if we hold
//     nothing we report the day as missing so the caller can decide
//     whether the crawl is still publishable.
//   - transient failures (timeouts, 429, 5xx) get bounded retries with
//     exponential backoff + jitter, and are never written to cache.

import * as cheerio from "cheerio";

const MONTHS = {
  januari: "01", februari: "02", maart: "03", april: "04", mei: "05", juni: "06",
  juli: "07", augustus: "08", september: "09", oktober: "10", november: "11", december: "12",
};

// ---------- Shared artist-name normalization ----------
// One function, used everywhere (tracked sets, agenda pre-filter,
// authoritative confirmation, scoring lookups, archive matching) so that
// two places can never disagree about whether two names are "the same".
export function normalizeArtistName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")   // strip diacritics (Sólstafir -> solstafir)
    .replace(/\s+/g, " ")
    .trim();
}

export function isArtistMatch(a, b) {
  return normalizeArtistName(a) === normalizeArtistName(b);
}

// ---------- Lineup parsing ----------
// Conservative on purpose. We split on " + " and " • " (always surrounded
// by whitespace on a real bill) but NEVER on "/" — that character appears
// inside legitimate names like AC/DC and "SPOT / De Oosterpoort".
// If the whole title exactly matches something we already track, we don't
// split at all: a tracked name is stronger evidence than any separator.
export function splitLineup(rawTitle, trackedSet = null) {
  const cleaned = (rawTitle || "").replace(/^Concert\s+/i, "").trim();
  if (!cleaned) return [];

  if (trackedSet && trackedSet.has(normalizeArtistName(cleaned))) {
    return [cleaned];
  }

  const parts = cleaned
    .split(/\s+[+•]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length ? parts : [cleaned];
}

// ---------- Throttled fetching with bounded retries ----------

const MIN_GAP_MS = 1200;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_ATTEMPTS = 4;
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffWithJitter(attempt, baseMs = 2000) {
  const exp = baseMs * 2 ** attempt;
  return Math.round(exp * (0.7 + Math.random() * 0.6)); // ±30% jitter
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds) && asSeconds > 0) return asSeconds * 1000;
  const asDate = Date.parse(headerValue); // HTTP-date form
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

// Concurrency stays at 1 by design. We measured 4 and 6 in production and
// both produced a near-total 429 storm: Podiuminfo rate-limits concurrent
// connections, not just request frequency.
async function throttledFetch(url) {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (listening-mirror discovery bot; personal use)" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function fetchPage(url) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await throttledFetch(url);
      if (res.ok) return res.text();

      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        const delay = retryAfter ?? backoffWithJitter(attempt, res.status === 429 ? 3000 : 1500);
        console.warn(`Podiuminfo ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — ${url}`);
        await sleep(delay);
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      const transient = err.name === "AbortError" || err.name === "TypeError" || /HTTP 5|HTTP 429|fetch failed|network/i.test(err.message);
      if (transient && attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffWithJitter(attempt, 1500);
        console.warn(`Podiuminfo request failed (${err.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — ${url}`);
        await sleep(delay);
        continue;
      }
      break;
    }
  }
  throw new Error(`Podiuminfo request failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message || "unknown"} — ${url}`);
}

// ---------- Day agenda pages (candidate discovery) ----------

function buildDayUrl(dateStr) {
  const [year, month, day] = dateStr.split("-");
  return `https://www.podiuminfo.nl/concertagenda/${year}/${month}/${day}/`;
}

function findCandidatesOnDayPage(html) {
  const $ = cheerio.load(html);
  const candidates = new Map(); // concertId -> { href, rawTitle }

  $('a[href*="/concert/"]').each((_, node) => {
    const $a = $(node);
    const href = $a.attr("href") || "";
    const m = href.match(/\/concert\/(\d+)\//);
    if (!m) return;
    const concertId = m[1];

    const titleAttr = $a.attr("title") || "";
    const tm = titleAttr.match(/^Concert\s+(.+?)\s+in\s+/i);
    if (!tm) return;

    if (!candidates.has(concertId)) {
      candidates.set(concertId, { href, rawTitle: tm[1] });
    }
  });

  return candidates;
}

const DAY_CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours

function candidatesFromCacheEntry(entry) {
  const map = new Map();
  for (const c of entry.candidates || []) {
    map.set(c.concertId, { href: c.href, rawTitle: c.rawTitle ?? (Array.isArray(c.lineup) ? c.lineup.join(" + ") : "") });
  }
  return map;
}

/**
 * Fetch one day's candidates, honouring the cache and degrading safely.
 * Returns { candidates, status } where status is "fresh" | "cached" |
 * "stale" (served from an old entry because refresh failed) | "missing"
 * (refresh failed and we hold nothing — the day is UNKNOWN, not empty).
 *
 * forceRefresh bypasses the freshness check but never discards the old
 * entry up-front: the cached value is only replaced after a successful
 * fetch, so a failing force-refresh leaves us no worse off than before.
 */
async function getDayCandidates(dateStr, dayCacheEntries, { forceRefresh = false } = {}) {
  const cached = dayCacheEntries[dateStr];
  const cachedIsUsable = cached && Array.isArray(cached.candidates);
  const isFresh = cachedIsUsable && Date.now() - new Date(cached.checkedAt).getTime() < DAY_CACHE_MAX_AGE_MS;

  if (cachedIsUsable && isFresh && !forceRefresh) {
    return { candidates: candidatesFromCacheEntry(cached), status: "cached" };
  }

  try {
    const html = await fetchPage(buildDayUrl(dateStr));
    const candidates = findCandidatesOnDayPage(html);
    dayCacheEntries[dateStr] = {
      checkedAt: new Date().toISOString(),
      candidates: [...candidates.entries()].map(([concertId, v]) => ({
        concertId,
        href: v.href,
        rawTitle: v.rawTitle,
      })),
    };
    return { candidates, status: "fresh" };
  } catch (err) {
    if (cachedIsUsable) {
      console.warn(`Day ${dateStr} refresh failed (${err.message}) — serving stale cache.`);
      return { candidates: candidatesFromCacheEntry(cached), status: "stale" };
    }
    console.warn(`Day ${dateStr} failed and no cache available (${err.message}) — day treated as UNKNOWN, not empty.`);
    return { candidates: new Map(), status: "missing" };
  }
}

// ---------- Individual concert pages (authoritative data) ----------

// Expected <title>: "Concert {Artist(s)} in {Venue}, {City} op [weekday] {day} {month} {year}"
// The weekday is optional — the real <title> usually omits it even though
// the meta-description includes it.
function parseConcertPageTitle(html, trackedSet) {
  const $ = cheerio.load(html);
  const titleText = ($("head title").first().text() || $("title").first().text() || "").trim();

  const m = titleText.match(
    /^Concert\s+(.+?)\s+in\s+(.+?)\s+op\s+(?:\S+\s+)?(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})/i
  );
  if (!m) return null;

  const [, lineupRaw, venueCityRaw, day, monthName, year] = m;

  // "TivoliVredenburg, Utrecht" — split on the LAST comma, since a venue
  // name could itself contain one.
  const lastComma = venueCityRaw.lastIndexOf(",");
  let venue = venueCityRaw.trim();
  let city = null;
  if (lastComma !== -1) {
    venue = venueCityRaw.slice(0, lastComma).trim();
    city = venueCityRaw.slice(lastComma + 1).trim();
  }

  const date = `${year}-${MONTHS[monthName.toLowerCase()]}-${day.padStart(2, "0")}`;
  const ticketHref = $('a[href*="/ticket/"]').first().attr("href") || null;

  return {
    lineup: splitLineup(lineupRaw.trim(), trackedSet),
    venue,
    city,
    date,
    image: extractArtistImage($, html),
    ticketUrl: ticketHref ? (ticketHref.startsWith("http") ? ticketHref : `https://www.podiuminfo.nl${ticketHref}`) : null,
    parserVersion: CONCERT_PARSER_VERSION,
  };
}

// Podiuminfo concert pages carry NO og:image — verified directly against a
// live page. The artist photo does exist though, in a couple of places:
// an <img> inside the artist link, and a markerimage= parameter on the
// embedded map. We try both, then fall back to any artist image URL in the
// markup. Note these are small (the ~100px "100_NAME_1.jpg" variant), so
// they're deliberately used as a blurred backdrop rather than sharp art.
function extractArtistImage($, html) {
  const fromImgTag = $('a[href*="/artist/"] img').map((_, n) => $(n).attr("src")).get()
    .find((src) => src && /\/img\/artist\//.test(src));
  if (fromImgTag) {
    return fromImgTag.startsWith("http") ? fromImgTag : `https://www.podiuminfo.nl${fromImgTag}`;
  }

  const marker = html.match(/markerimage=(https?:\/\/[^&"'\s]+\.(?:jpg|jpeg|png))/i);
  if (marker) return marker[1];

  const any = html.match(/https?:\/\/[^"'\s)]*\/img\/artist\/\d+\/[^"'\s)]+\.(?:jpg|jpeg|png)/i);
  return any ? any[0] : null;
}

// Bumping this invalidates cached concert details so a parser improvement
// actually reaches existing entries instead of being masked by the cache.
// v2 added artist-image extraction.
const CONCERT_PARSER_VERSION = 2;
const CONCERT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------- Country detection ----------
// Podiuminfo's agenda covers NL *and* BE; nothing in the page title says
// which, only the city does. We keep an explicit list of Belgian cities
// seen in real data and return null (UNKNOWN) for anything unrecognised —
// deliberately NOT defaulting to NL, so the caller can decide rather than
// silently mislabelling a Belgian show as Dutch.
const BELGIAN_CITIES = new Set([
  "brussel", "brussels", "bruxelles", "antwerpen", "gent", "brugge", "leuven",
  "hasselt", "turnhout", "liege", "luik", "charleroi", "mechelen", "kortrijk",
  "oostende", "namur", "namen", "mons", "bergen", "ieper", "aalst", "roeselare",
  "sint-niklaas", "genk", "seraing", "deurne", "gentbrugge", "diest", "lier",
  "geel", "vilvoorde", "waregem", "kontich", "dendermonde", "beringen",
  "sint-truiden", "tienen", "wevelgem", "eeklo", "ronse", "lokeren", "peer",
  "zottegem", "boom", "heist-op-den-berg", "wetteren", "izegem", "menen",
  "tongeren", "geraardsbergen", "vosselaar", "opwijk", "temse", "lommel",
]);

const DUTCH_CITIES = new Set([
  "amsterdam", "rotterdam", "utrecht", "den haag", "eindhoven", "groningen",
  "tilburg", "nijmegen", "haarlem", "arnhem", "enschede", "apeldoorn",
  "amersfoort", "zwolle", "breda", "maastricht", "leiden", "dordrecht",
  "deventer", "alkmaar", "delft", "helmond", "hilversum", "heerlen", "venlo",
  "leeuwarden", "purmerend", "zaandam", "almere", "lelystad", "hengelo",
  "sittard", "roermond", "vlissingen", "middelburg", "assen", "emmen",
  "hoorn", "gouda", "zoetermeer", "ede", "oss", "schiedam", "spijkenisse",
  "nieuwegein", "veenendaal", "doetinchem", "kerkrade", "weert", "uden",
  "bergen op zoom", "roosendaal", "terneuzen", "goes", "drachten", "sneek",
  "heerenveen", "meppel", "steenwijk", "winterswijk", "zutphen", "harderwijk",
]);

export function detectCountry(city) {
  const key = normalizeArtistName(city); // same normalization is fine for city names
  if (!key) return null;
  if (BELGIAN_CITIES.has(key)) return "BE";
  if (DUTCH_CITIES.has(key)) return "NL";
  return null; // UNKNOWN — caller decides
}

// ---------- Discovery ----------

/**
 * Crawls every day in [startDate, endDate] and returns ONE entry per
 * Podiuminfo concert id whose authoritative lineup contains at least one
 * tracked artist.
 *
 * Returns { events, stats } — stats lets the caller judge whether the
 * crawl was complete enough to publish.
 */
export async function discoverEvents({
  trackedArtistNames,
  startDate,
  endDate,
  dayCacheEntries,
  concertCacheEntries,
  forceRefresh = false,
  onProgress = null,
}) {
  const trackedSet = new Set(trackedArtistNames.map(normalizeArtistName));
  const toOpen = new Map(); // concertId -> href

  const stats = { daysTotal: 0, daysFresh: 0, daysCached: 0, daysStale: 0, daysMissing: 0, concertsFailed: 0, concertsOpened: 0 };

  const cursor = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    stats.daysTotal++;

    const { candidates, status } = await getDayCandidates(dateStr, dayCacheEntries, { forceRefresh });
    if (status === "fresh") stats.daysFresh++;
    else if (status === "cached") stats.daysCached++;
    else if (status === "stale") stats.daysStale++;
    else stats.daysMissing++;

    for (const [concertId, { href, rawTitle }] of candidates.entries()) {
      const coarseLineup = splitLineup(rawTitle, trackedSet);
      const relevant = coarseLineup.some((name) => trackedSet.has(normalizeArtistName(name)));
      if (relevant && !toOpen.has(concertId)) toOpen.set(concertId, href);
    }

    if (onProgress && stats.daysTotal % 30 === 0) await onProgress(stats);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  console.log(
    `Day crawl: ${stats.daysTotal} days (${stats.daysFresh} fresh, ${stats.daysCached} cached, ` +
    `${stats.daysStale} stale, ${stats.daysMissing} missing) → ${toOpen.size} candidate concerts.`
  );

  let rejectedByLineup = 0;
  const events = [];
  for (const [concertId, href] of toOpen.entries()) {
    const cached = concertCacheEntries[concertId];
    const cacheUsable = cached && Array.isArray(cached.lineup) && cached.date &&
      cached.parserVersion === CONCERT_PARSER_VERSION;
    let parsed;

    if (cacheUsable && Date.now() - new Date(cached.cachedAt).getTime() < CONCERT_CACHE_MAX_AGE_MS) {
      parsed = cached;
    } else {
      const url = href.startsWith("http") ? href : `https://www.podiuminfo.nl${href}`;
      try {
        const html = await fetchPage(url);
        parsed = parseConcertPageTitle(html, trackedSet);
        if (!parsed) {
          const $ = cheerio.load(html);
          const rawTitle = ($("head title").first().text() || "(no title)").trim();
          console.warn(`Unparseable concert page ${url} — title was: "${rawTitle}"`);
          stats.concertsFailed++;
          continue;
        }
        parsed.url = url;
        parsed.cachedAt = new Date().toISOString();
        concertCacheEntries[concertId] = parsed;
        stats.concertsOpened++;
      } catch (err) {
        // Transient failure: fall back to whatever we already hold rather
        // than dropping a concert we know exists.
        if (cacheUsable) {
          console.warn(`Concert ${concertId} refresh failed (${err.message}) — using stale detail.`);
          parsed = cached;
        } else {
          console.warn(`Concert ${concertId} failed and no cache (${err.message}) — skipped.`);
          stats.concertsFailed++;
          continue;
        }
      }
    }

    const matchedTracked = parsed.lineup.filter((name) => trackedSet.has(normalizeArtistName(name)));
    if (matchedTracked.length === 0) {
      // The coarse day-page title said this was relevant but the
      // authoritative lineup disagrees. A handful is normal; a flood means
      // the two stages are reading names differently (e.g. a stale cache
      // written by an older parser).
      if (rejectedByLineup < 5) {
        console.warn(`Rejected ${concertId}: authoritative lineup [${parsed.lineup.join(" | ")}] has no tracked artist.`);
      }
      rejectedByLineup++;
      continue;
    }

    events.push({
      concertId,
      url: parsed.url,
      lineup: parsed.lineup,
      matchedTracked,
      venue: parsed.venue,
      city: parsed.city,
      country: detectCountry(parsed.city),
      date: parsed.date,
      image: parsed.image || null,
      ticketUrl: parsed.ticketUrl || null,
    });
  }

  console.log(
    `Confirmed ${events.length} events from ${toOpen.size} candidates ` +
    `(${rejectedByLineup} rejected on authoritative lineup, ${stats.concertsFailed} unreadable).`
  );
  stats.rejectedByLineup = rejectedByLineup;

  return { events, stats };
}
