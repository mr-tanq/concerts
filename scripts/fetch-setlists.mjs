#!/usr/bin/env node
// fetch-setlists.mjs
//
// Fills data/setlists.json with the songs played at concerts in the archive.
//
// The matching logic is ported from the old Cloudflare Worker rather than
// written fresh: it had already been tuned against real data. The detail
// that matters most is that setlist.fm search is loose — asking for an
// artist on a date happily returns their show in another country — so every
// candidate is scored on artist, date, city and venue, and a threshold is
// enforced. Attaching the wrong night's songs to a memory is worse than
// attaching none.
//
// Festivals are treated slightly differently: a multi-day festival can list
// a set a day either side of the date recorded, but a same-day match in the
// wrong city with no other local signal is rejected outright.
//
// Requires the SETLISTFM_API_KEY secret.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const OUT = path.join(ROOT, "data/setlists.json");

const API_KEY = process.env.SETLISTFM_API_KEY;
if (!API_KEY) {
  console.error("Missing SETLISTFM_API_KEY — add it under Settings > Secrets and variables > Actions.");
  process.exit(1);
}

// setlist.fm asks for no more than ~2 requests/second.
const MIN_GAP_MS = 600;
// Bound each run so a first pass over a large archive can't hit the job
// timeout. Re-running picks up where it left off.
const MAX_LOOKUPS_PER_RUN = Number(process.env.MAX_LOOKUPS || 120);
// A concert that yielded nothing is retried occasionally — setlists get
// added to setlist.fm long after the show.
const RETRY_MISSES_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// setlist.fm dates are DD-MM-YYYY, ours are ISO.
function isoToSetlistFm(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

function parseSetlistFmDate(v) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(v || "").trim());
  return m ? Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

function dayGap(a, b) {
  const da = parseSetlistFmDate(a);
  const db = parseSetlistFmDate(b);
  if (da == null || db == null) return 999;
  return Math.abs(Math.round((da - db) / 86400000));
}

function looksLikeFestivalStage(venue) {
  const v = norm(venue);
  return !!v && /(stage|tent|arena|festival|open air|terrein|weide)/.test(v);
}

function scoreCandidate(concert, item, { targetArtist, isFestival }) {
  const wantArtist = norm(targetArtist);
  const wantDate = isoToSetlistFm(concert.date);
  const wantCity = norm(concert.city);
  const wantVenue = norm(concert.venue);
  const wantCountry = norm(concert.country);

  const gotArtist = norm(item?.artist?.name);
  const gotDate = String(item?.eventDate || "");
  const gotCity = norm(item?.venue?.city?.name);
  const gotVenue = norm(item?.venue?.name);
  const gotCountry = norm(item?.venue?.city?.country?.name || item?.venue?.city?.country?.code);

  let score = 0;

  if (wantArtist && gotArtist) {
    if (wantArtist === gotArtist) score += 45;
    else if (wantArtist.includes(gotArtist) || gotArtist.includes(wantArtist)) score += 28;
  }

  const gap = dayGap(gotDate, wantDate);
  if (gap === 0) score += 35;
  else if (isFestival && gap === 1) score += 18;
  else if (isFestival && gap === 2) score += 8;
  else if (!isFestival && gap === 1) score += 4;

  if (wantCity && gotCity) {
    if (wantCity === gotCity) score += 22;
    else if (wantCity.includes(gotCity) || gotCity.includes(wantCity)) score += 10;
  }

  if (wantVenue && gotVenue) {
    if (wantVenue === gotVenue) score += 18;
    else if (wantVenue.includes(gotVenue) || gotVenue.includes(wantVenue)) score += 10;
    else if (isFestival && looksLikeFestivalStage(gotVenue)) score += 6;
  }

  if (wantCountry && gotCountry && wantCountry === gotCountry) score += 8;

  if (isFestival) {
    const wrongCountry = wantCountry && gotCountry && wantCountry !== gotCountry;
    const wrongCitySameDay = gap === 0 && wantCity && gotCity && wantCity !== gotCity;
    const noLocalSignal =
      !(wantCity && gotCity && wantCity === gotCity) &&
      !(wantVenue && gotVenue &&
        (wantVenue === gotVenue || wantVenue.includes(gotVenue) || gotVenue.includes(wantVenue))) &&
      !looksLikeFestivalStage(gotVenue);

    if (wrongCountry && gap <= 1 && noLocalSignal) {
      return { score: -1, rejected: true, reason: "festival, wrong country, no local signal" };
    }
    if (wrongCitySameDay && noLocalSignal) {
      return { score: -1, rejected: true, reason: "festival, same day wrong city, no local signal" };
    }
    if (gap > 2) return { score: -1, rejected: true, reason: "festival, date too far" };
  }

  return { score, rejected: false, reason: null };
}

function extractSets(item) {
  const raw = item?.sets?.set;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr
    .map((setObj, i) => {
      const rawSongs = setObj?.song;
      const songArr = Array.isArray(rawSongs) ? rawSongs : rawSongs ? [rawSongs] : [];
      const songs = songArr
        .map((s) => (typeof s === "string" ? s : s?.name))
        .map((s) => String(s || "").trim())
        .filter(Boolean);
      if (!songs.length) return null;
      const name =
        String(setObj?.name || "").trim() ||
        (setObj?.encore ? `Encore ${setObj.encore}` : i === 0 ? "Set" : `Set ${i + 1}`);
      return { name, songs };
    })
    .filter(Boolean);
}

let lastCall = 0;
async function apiGet(url) {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": API_KEY,
        Accept: "application/json",
        "User-Agent": "ListeningMirror/1.0 (personal concert archive)",
      },
      signal: controller.signal,
    });
    // 404 means "nothing matched", which is a normal answer, not a fault.
    if (res.status === 404) return null;
    if (res.status === 429) {
      console.warn("Rate limited — pausing 10s");
      await sleep(10000);
      return apiGet(url);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function searchSetlists(params) {
  const u = new URL("https://api.setlist.fm/rest/1.0/search/setlists");
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, String(v));
  u.searchParams.set("p", "1");
  const json = await apiGet(u.toString()).catch(() => null);
  const arr = json?.setlist;
  if (Array.isArray(arr)) return arr;
  return arr ? [arr] : [];
}

async function findSetlist(concert, artist) {
  const isFestival = !!concert.isFestival;
  const dateForApi = isoToSetlistFm(concert.date);
  const year = String(concert.date || "").slice(0, 4);

  const attempts = [
    { artistName: artist, date: dateForApi, cityName: concert.city },
    { artistName: artist, date: dateForApi },
    { artistName: artist, year, cityName: concert.city },
    { artistName: artist, year, venueName: concert.venue },
  ];

  let best = null;
  let bestScore = -1;

  for (const params of attempts) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
    if (!clean.artistName) continue;

    const results = await searchSetlists(clean);
    for (const item of results.slice(0, 25)) {
      const { score, rejected } = scoreCandidate(concert, item, { targetArtist: artist, isFestival });
      if (rejected) continue;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    if (!isFestival && bestScore >= 92) break;
    if (isFestival && bestScore >= 88) break;
  }

  const minScore = isFestival ? 82 : 75;
  if (!best || bestScore < minScore) return null;

  let sets = extractSets(best);

  // Search results sometimes omit the songs; the by-id endpoint has them.
  if (!sets.length && best.id) {
    const full = await apiGet(`https://api.setlist.fm/rest/1.0/setlist/${encodeURIComponent(best.id)}`).catch(() => null);
    if (full) sets = extractSets(full);
  }
  if (!sets.length) return null;

  return {
    artist,
    sets,
    songCount: sets.reduce((n, s) => n + s.songs.length, 0),
    sourceUrl: best.url || null,
    setlistFmId: best.id || null,
    matchScore: bestScore,
  };
}

// --- run ---

const archive = JSON.parse(await readFile(path.join(ROOT, "data/archive.json"), "utf8"));

let store = { setlists: {} };
try {
  const prev = JSON.parse(await readFile(OUT, "utf8"));
  store.setlists = prev.setlists || {};
} catch {
  // first run
}

const today = new Date().toISOString().slice(0, 10);
const past = (archive.concerts || [])
  .filter((c) => c.date && c.date <= today)                       // a future show has no setlist yet
  .sort((a, b) => String(b.date).localeCompare(String(a.date)));  // recent first

const queue = [];
for (const c of past) {
  const prev = store.setlists[c.id];
  if (prev?.sets?.length) continue;                               // already have it
  if (prev && Date.now() - new Date(prev.checkedAt || 0).getTime() < RETRY_MISSES_AFTER_MS) continue;
  queue.push(c);
}

const batch = queue.slice(0, MAX_LOOKUPS_PER_RUN);
console.log(`${past.length} past concerts, ${queue.length} still to check, doing ${batch.length} this run.`);

let found = 0;
let none = 0;
let errors = 0;

for (const c of batch) {
  // For a festival the "artist" is the festival name, which setlist.fm
  // won't know — use the top-billed act instead.
  const artist = c.isFestival ? (c.lineup?.[0] || c.artist) : c.artist;
  try {
    const result = await findSetlist(c, artist);
    if (result) {
      store.setlists[c.id] = { ...result, checkedAt: new Date().toISOString() };
      found++;
      console.log(`  ✓ ${c.date} ${artist} — ${result.songCount} songs (score ${result.matchScore})`);
    } else {
      store.setlists[c.id] = { artist, sets: [], checkedAt: new Date().toISOString() };
      none++;
    }
  } catch (err) {
    console.warn(`  ✗ ${c.date} ${artist}: ${err.message}`);
    errors++;
  }
}

const withSets = Object.values(store.setlists).filter((s) => s.sets?.length).length;
const remaining = Math.max(0, queue.length - batch.length);

await writeFile(
  OUT,
  JSON.stringify(
    {
      $schema: "Listening Mirror Setlists v1",
      meta: {
        lastUpdated: new Date().toISOString(),
        checked: Object.keys(store.setlists).length,
        withSetlist: withSets,
        remaining,
      },
      setlists: store.setlists,
    },
    null,
    2
  ) + "\n"
);

console.log(`Found ${found}, no match ${none}, errors ${errors}.`);
console.log(`${withSets} concerts now have a setlist. ${remaining} left — re-run to continue.`);