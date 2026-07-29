#!/usr/bin/env node
// enrich-artist-images.mjs
//
// Builds data/artist-images.json — one photo per artist, keyed by
// normalized name.
//
// WHY THIS EXISTS
// Photos used to come only from data/podiuminfo-cache.json, which holds
// exactly the concerts the discovery crawler happened to open. That covers
// a few dozen artists with upcoming NL/BE shows and nothing else, so most
// of the archive — hundreds of artists going back to 2001, including every
// festival support act — had no image at all.
//
// Deezer's public catalog API needs no key and returns picture_xl at
// 1000x1000, big enough to display sharp instead of blurred. It does block
// CORS, so it can never be called from the browser; this runs in the Action
// and the app just reads the resulting static file.
//
// Matching is exact on the normalized name, with fan count as the
// tie-breaker. Fuzzy matching was tempting for a name like "Mono" but it
// puts the wrong band's face on your memories, which is worse than a
// missing photo.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const OUT = path.join(ROOT, "data/artist-images.json");

// Deezer allows roughly 50 requests per 5 seconds. 250ms between calls
// keeps us comfortably under that without needing backoff gymnastics.
const MIN_GAP_MS = 250;
const REFRESH_AFTER_MS = 180 * 24 * 60 * 60 * 1000; // re-check misses twice a year

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadJson(rel, fallback) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, rel), "utf8"));
  } catch {
    return fallback;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
async function deezerSearchArtist(name) {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=10`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } finally {
    clearTimeout(timeout);
  }
}

function pickBestMatch(candidates, wantedName) {
  const wanted = normalizeName(wantedName);
  const exact = candidates.filter((c) => normalizeName(c.name) === wanted);
  if (exact.length === 0) return null;
  // Several artists genuinely share a name (Mono, Archive, Iron & Wine).
  // Fan count is the only signal available here, and the well-known one is
  // overwhelmingly the one being referred to.
  return exact.sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0];
}

function bestPicture(artist) {
  return artist?.picture_xl || artist?.picture_big || artist?.picture_medium || null;
}

// --- collect every artist name we might ever need to show ---

const archive = await loadJson("data/archive.json", { concerts: [] });
const planned = await loadJson("data/planned.json", { concerts: [] });
const recs = await loadJson("data/recommendations.json", { concerts: [] });
const history = await loadJson("data/recommendation-history.json", {});

const names = new Map(); // normalized -> display name
function note(name) {
  const key = normalizeName(name);
  if (key && !names.has(key)) names.set(key, String(name).trim());
}

function collect(list) {
  for (const c of list || []) {
    if (Array.isArray(c.lineup) && c.lineup.length) c.lineup.forEach(note);
    else {
      note(c.artist);
      (c.supportingArtists || []).forEach(note);
    }
  }
}

collect(archive.concerts);
collect(planned.concerts);
collect(recs.concerts);
collect(history.dismissed);

// --- merge with what we already know ---

const existing = await loadJson("data/artist-images.json", { artists: {} });
const store = existing.artists || {};

const todo = [];
for (const [key, display] of names) {
  const prev = store[key];
  if (prev?.image) continue;                       // already resolved
  if (prev && Date.now() - new Date(prev.checkedAt).getTime() < REFRESH_AFTER_MS) continue;
  todo.push([key, display]);
}

console.log(`${names.size} distinct artists; ${todo.length} need a lookup.`);

let found = 0;
let missed = 0;
let failed = 0;

for (const [key, display] of todo) {
  try {
    const results = await deezerSearchArtist(display);
    const match = pickBestMatch(results, display);
    const image = bestPicture(match);
    if (image) {
      store[key] = {
        name: display,
        image,
        deezerId: match.id ?? null,
        source: "deezer",
        checkedAt: new Date().toISOString(),
      };
      found++;
    } else {
      // Record the miss so we don't re-query it on every run — but with a
      // timestamp, so it gets another chance once the refresh window passes.
      store[key] = { name: display, image: null, source: "deezer", checkedAt: new Date().toISOString() };
      missed++;
    }
  } catch (err) {
    console.warn(`Lookup failed for "${display}": ${err.message}`);
    failed++;
  }
}

const output = {
  $schema: "Listening Mirror Artist Images v1",
  meta: {
    lastUpdated: new Date().toISOString(),
    totalArtists: Object.keys(store).length,
    withImage: Object.values(store).filter((a) => a.image).length,
  },
  artists: store,
};

await writeFile(OUT, JSON.stringify(output, null, 2) + "\n");

console.log(`Found ${found}, no exact match ${missed}, errors ${failed}.`);
console.log(`data/artist-images.json now has ${output.meta.withImage}/${output.meta.totalArtists} artists with a photo.`);
