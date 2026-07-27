// sources/podiuminfo.mjs
//
// Two-phase approach:
//   Phase 1: search the concertagenda (?input_zoek=<artist>) to find which
//            concert PAGES mention this artist at all (coarse match on the
//            listing's anchor title attribute).
//   Phase 2: fetch each matched concert's OWN page and parse its <title>
//            tag, which follows a highly reliable format:
//              "Concert {Artist(s)} in {Venue}, {City} op {weekday} {day} {month} {year}"
//            This is the authoritative source for date/venue/city — NOT the
//            search-results listing DOM. An earlier version tried to infer
//            the date by climbing the listing page's DOM looking for a
//            nearby day heading; that produced systematically wrong dates
//            (multiple unrelated venues all collapsing onto one date) once
//            tested against real data. Fetching the concert's own page
//            costs one extra request per match, but is unambiguous.

import * as cheerio from "cheerio";

const BASE = "https://www.podiuminfo.nl/concertagenda/";
const MONTHS = {
  januari: "01", februari: "02", maart: "03", april: "04", mei: "05", juni: "06",
  juli: "07", augustus: "08", september: "09", oktober: "10", november: "11", december: "12",
};

function buildSearchUrl(artist, page = 1) {
  const params = new URLSearchParams({
    input_zoek: artist,
    input_datum: "",
    input_genre: "",
    input_livestream: "",
    input_not_cancelled: "1",
    input_plaats: "",
    input_podium: "",
    input_provincie: "",
    sort: "event_date_time_asc",
    page: String(page),
  });
  return `${BASE}?${params.toString()}`;
}

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

const MIN_GAP_MS = 700;
let lastRequestAt = 0;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttledFetch(url) {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
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

// ---------- Phase 1: find candidate concert URLs from the search listing ----------

function findCandidateConcertLinks(html) {
  const $ = cheerio.load(html);
  const candidates = new Map(); // concertId -> { href }

  $('a[href*="/concert/"]').each((_, node) => {
    const $a = $(node);
    const href = $a.attr("href") || "";
    const m = href.match(/\/concert\/(\d+)\/([^/]+)\/?/);
    if (!m) return;
    const [, concertId] = m;

    const titleAttr = $a.attr("title") || "";
    if (!/^Concert\s+/i.test(titleAttr)) return;

    if (!candidates.has(concertId)) {
      candidates.set(concertId, { concertId, href });
    }
  });

  return [...candidates.values()];
}

// ---------- Phase 2: fetch a concert's own page for authoritative data ----------

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

export async function searchPodiuminfo(artistName, { maxPages = 3 } = {}) {
  const candidateMap = new Map();

  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchPage(buildSearchUrl(artistName, page));
    const candidates = findCandidateConcertLinks(html);
    if (candidates.length === 0) break;

    let newOnThisPage = 0;
    for (const c of candidates) {
      if (!candidateMap.has(c.concertId)) {
        candidateMap.set(c.concertId, c.href);
        newOnThisPage++;
      }
    }
    if (newOnThisPage === 0) break;
  }

  const results = [];
  for (const [concertId, href] of candidateMap.entries()) {
    const url = href.startsWith("http") ? href : `https://www.podiuminfo.nl${href}`;
    let html;
    try {
      html = await fetchPage(url);
    } catch (err) {
      console.warn(`Failed to fetch concert page ${url}: ${err.message}`);
      continue;
    }
    const parsed = parseConcertPageTitle(html);
    if (!parsed) continue;

    const matches = parsed.lineup.some((name) => isArtistMatch(name, artistName));
    if (!matches) continue;

    results.push({ concertId, url, ...parsed });
  }

  return results;
}

export async function queryPodiuminfo(artistName) {
  const events = await searchPodiuminfo(artistName);
  return events
    .filter((e) => e.date)
    .map((e) => {
      const mainArtist = e.lineup.find((name) => isArtistMatch(name, artistName)) || e.lineup[0];
      const supporting = e.lineup.filter((name) => name !== mainArtist);
      return {
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
      };
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const artist = process.argv[2] || "Mono";
  const results = await queryPodiuminfo(artist);
  console.log(JSON.stringify(results, null, 2));
}