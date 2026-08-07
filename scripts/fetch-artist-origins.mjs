#!/usr/bin/env node
// fetch-artist-origins.mjs
//
// For every artist actually seen LIVE (from data/archive.json — not the
// wider listening history), looks up their country of origin via
// MusicBrainz and writes data/artist-origins.json. Powers the Realm tab's
// map: pins for the countries the bands you've stood in a room with
// actually come from.
//
// MusicBrainz because neither Last.fm nor Deezer expose country of origin
// at all — MusicBrainz's "area" field is the standard source for this.
// Matching is deliberately conservative: a result is only kept when the
// top candidate's name matches exactly (case-insensitive) and MusicBrainz's
// own confidence score is high. A wrong country shown back to the person
// is a factual error, worse than a missing one — same discipline as every
// other matching rule already in this codebase.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const OUT = path.join(ROOT, "data/artist-origins.json");

// Required by MusicBrainz's API etiquette — requests without a descriptive
// User-Agent are throttled harder or rejected outright.
const USER_AGENT = "ListeningMirror/1.0 (+https://github.com/mr-tanq/concerts)";
const MIN_GAP_MS = 1100; // MusicBrainz asks for max ~1 request/second
const MIN_SCORE = 90;    // MusicBrainz's own 0-100 confidence; only trust a strong match

let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeName(name) {
  return (name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

async function loadJson(rel, fallback) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, rel), "utf8"));
  } catch {
    return fallback;
  }
}

async function lookupCountry(artistName, attempts = 3) {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${artistName}"`)}&fmt=json&limit=5`;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      let res;
      try {
        res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (res.status === 503 && attempt < attempts - 1) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const top = (json.artists || [])[0];
      if (!top) return null;
      // Exact-match discipline: the top result's own name (or one of its
      // aliases via sort-name) must match what we searched for, and
      // MusicBrainz's confidence score must be high. Anything looser risks
      // putting the wrong band's home country on the map.
      const nameMatches = normalizeName(top.name) === normalizeName(artistName) ||
                           normalizeName(top["sort-name"]) === normalizeName(artistName);
      if (!nameMatches || Number(top.score) < MIN_SCORE) return null;
      if (!top.country) return null;
      return { code: top.country, name: top.area?.name || top.country };
    } catch (err) {
      if (attempt === attempts - 1) {
        console.warn(`lookup failed for "${artistName}": ${err.message}`);
        return null;
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  return null;
}

// --- collect every artist actually seen live ---

function artistsOf(c) {
  if (c.isFestival) return (c.lineup || []).filter(Boolean);
  return [c.artist, ...(c.supportingArtists || [])].filter(Boolean);
}

const archive = await loadJson("data/archive.json", { concerts: [] });
const names = new Map(); // normalized -> display name
for (const c of archive.concerts || []) {
  for (const name of artistsOf(c)) {
    const key = normalizeName(name);
    if (key && !names.has(key)) names.set(key, String(name).trim());
  }
}

const existing = await loadJson("data/artist-origins.json", { artists: {} });
const store = existing.artists || {};

const REFRESH_AFTER_MS = 365 * 24 * 60 * 60 * 1000; // a band's home country doesn't change; re-check misses yearly
const todo = [];
for (const [key, display] of names) {
  const prev = store[key];
  if (prev?.country) continue; // already resolved
  if (prev && Date.now() - new Date(prev.checkedAt).getTime() < REFRESH_AFTER_MS) continue;
  todo.push([key, display]);
}

console.log(`${names.size} distinct artists seen live; ${todo.length} need a lookup.`);

let found = 0, missed = 0;
for (const [key, display] of todo) {
  const result = await lookupCountry(display);
  if (result) {
    store[key] = { name: display, country: result.code, countryName: result.name, checkedAt: new Date().toISOString() };
    found++;
  } else {
    store[key] = { name: display, country: null, checkedAt: new Date().toISOString() };
    missed++;
  }
}

await writeFile(OUT, JSON.stringify({ $schema: "Listening Mirror Artist Origins v1", artists: store }, null, 2) + "\n");
console.log(`Wrote data/artist-origins.json — ${found} resolved, ${missed} missed this run, ${Object.keys(store).length} total on file.`);