// sources/podiuminfo.mjs
//
// Podiuminfo is NOT an artist-page lookup here — per spec, we search their
// concertagenda EVENT database directly (?input_zoek=<artist>) and parse
// every matching event row. This naturally supports:
//   - exact artist matches
//   - artists in multi-band lineups (title = "A + B", "A / B", "A • B • C")
//   - multiple consecutive dates / the same artist at different venues on
//     different days (each occurrence has its own unique Podiuminfo
//     concert id — that id IS our dedup key, so no extra logic needed)
//   - festival lineups (Podiuminfo lists individual festival-day
//     appearances as their own concert ids when an artist plays a festival)
//
// KNOWN LIMITATION — please read before relying on this in production:
// Podiuminfo's markup was inspected through a text/markdown-rendering
// fetch (not raw HTML source), so the exact date/venue DOM structure is
// inferred from visible patterns rather than verified against real tags.
// The two things most likely to need a tweak once you run this for real:
//   1. `extractDateForAnchor()` — the day-grouping heuristic
//   2. the artist-splitting regex for multi-act titles
// If matches come back with wrong/missing dates, dump the raw HTML of one
// search result page (see `--dump` flag below) and send it over — that's
// a five-minute fix once we can see real tags instead of guessing.

import * as cheerio from "cheerio";

const BASE = "https://www.podiuminfo.nl/concertagenda/";
const WEEKDAYS = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
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

// Parses "maandag 22 juli 2026" / "wo 22 jul" style headers into YYYY-MM-DD.
// Podiuminfo shows both a short form in the compact table and a long form
// in the expanded per-day blocks — we only need one to resolve successfully.
function parseDutchDateHeading(text) {
  const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
  const longMatch = clean.match(/(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})/);
  if (longMatch) {
    const [, day, monthName, year] = longMatch;
    return `${year}-${MONTHS[monthName]}-${day.padStart(2, "0")}`;
  }
  return null;
}

// Splits an event title into [mainArtists..., supportingArtists...] using
// the separators Podiuminfo actually uses for shared bills. Order matters:
// try the least ambiguous separators first.
function splitLineup(title) {
  const cleaned = title.replace(/^Concert\s+/i, "");
  const parts = cleaned
    .split(/\s*(?:\+|•|\/)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [cleaned.trim()];
}

function isArtistMatch(candidate, wanted) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return norm(candidate).includes(norm(wanted)) || norm(wanted).includes(norm(candidate));
}

// Podiuminfo will 429 (rate-limit) us if we fire requests back-to-back
// across many artists in a loop. We enforce a minimum gap between ANY two
// requests (module-level, shared across all calls) and back off hard,
// respecting Retry-After, whenever we do get rate-limited.
const MIN_GAP_MS = 1200;
let lastRequestAt = 0;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttledFetch(url) {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  return fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (listening-mirror discovery bot; personal use)" },
  });
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

function parseSearchResultsPage(html) {
  const $ = cheerio.load(html);
  const events = [];

  $('a[href*="/concert/"]').each((_, node) => {
    const $a = $(node);
    const href = $a.attr("href") || "";
    const m = href.match(/\/concert\/(\d+)\/([^/]+)\/([^/]+)\/?/);
    if (!m) return;
    const [, concertId, , venueSlug] = m;

    const titleAttr = $a.attr("title") || "";
    const tm = titleAttr.match(/^Concert\s+(.+?)\s+in\s+(.+)$/i);
    if (!tm) return;
    const [, eventTitle, venueName] = tm;

    let city = null;
    const $container = $a.closest("li, tr, div");
    const $containerClone = $container.clone();
    $containerClone.find('a[href*="/ticket/"], img').remove();
    const containerText = $containerClone.text().replace(/\s+/g, " ").trim();
    const afterVenue = containerText.split(venueName)[1];
    if (afterVenue) {
      const cityMatch = afterVenue.match(/^[,\s]*([A-ZÀ-Ý][\wÀ-ÿ'.\-]*(?:\s[A-ZÀ-Ý][\wÀ-ÿ'.\-]*){0,2})/);
      if (cityMatch) city = cityMatch[1].trim();
    }

    let date = null;
    let cursor = $container;
    for (let i = 0; i < 6 && cursor.length && !date; i++) {
      const headingText = cursor.prevAll().text();
      date = parseDutchDateHeading(headingText);
      cursor = cursor.parent();
    }

    const ticketHref = $container.find('a[href*="/ticket/"]').attr("href") || null;
    const img = $container.find("img").attr("src") || null;
    const lineup = splitLineup(eventTitle);

    events.push({
      concertId,
      venueSlug,
      title: eventTitle,
      lineup,
      venue: venueName,
      city,
      date,
      url: `https://www.podiuminfo.nl${href}`,
      ticketUrl: ticketHref ? `https://www.podiuminfo.nl${ticketHref}` : null,
      image: img,
    });
  });

  return events;
}

export async function searchPodiuminfo(artistName, { maxPages = 3 } = {}) {
  const seen = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchPage(buildSearchUrl(artistName, page));
    const events = parseSearchResultsPage(html);
    if (events.length === 0) break;

    let matchedOnThisPage = 0;
    for (const ev of events) {
      const matches = ev.lineup.some((name) => isArtistMatch(name, artistName));
      if (!matches) continue;
      matchedOnThisPage++;
      if (!seen.has(ev.concertId)) seen.set(ev.concertId, ev);
    }
    if (matchedOnThisPage === 0) break;
  }
  return [...seen.values()];
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
  const dump = process.argv.includes("--dump");
  const html = await fetchPage(buildSearchUrl(artist, 1));
  if (dump) {
    console.log(html.slice(0, 5000));
  } else {
    const results = await queryPodiuminfo(artist);
    console.log(JSON.stringify(results, null, 2));
  }
      }
