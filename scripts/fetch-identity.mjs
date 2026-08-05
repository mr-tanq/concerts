#!/usr/bin/env node
// fetch-identity.mjs
//
// Last.fm's API sets no Access-Control-Allow-Origin header, so it can never
// be called directly from the browser — confirmed, not assumed. This runs
// server-side instead and writes data/identity.json, exactly the pattern
// already used for artist images (Deezer) and setlists (setlist.fm): the
// app only ever reads a static file for this tab, never talks to Last.fm
// itself. No new secret is needed — LASTFM_API_KEY and LASTFM_USER already
// exist for the concert-discovery pipeline.
//
// This is a "who are you" page, not a "what's happening right now" page —
// unlike Mirror, a periodic refresh (this runs on the same schedule as
// discovery) is not just acceptable but the more honest cadence for an
// identity built from listening habits rather than a single instant.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const OUT = path.join(ROOT, "data/identity.json");

const API_KEY = process.env.LASTFM_API_KEY;
const USER = process.env.LASTFM_USER;
if (!API_KEY || !USER) {
  console.error("Missing LASTFM_API_KEY or LASTFM_USER.");
  process.exit(1);
}

const MIN_GAP_MS = 300;
let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lastfm(method, params = {}, attempts = 3) {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.searchParams.set("method", method);
  url.searchParams.set("user", USER);
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json?.error) throw new Error(`Last.fm error ${json.error}: ${json.message || "unknown"}`);
      return json;
    } catch (err) {
      if (attempt === attempts - 1) throw err;
      console.warn(`${method} failed (${err.message}), retrying...`);
      await sleep(1000 * (attempt + 1));
    }
  }
}

function toIso(unixSeconds) {
  const n = Number(unixSeconds);
  return n ? new Date(n * 1000).toISOString() : null;
}

// --- profile ---
console.log(`Fetching Last.fm identity for ${USER}...`);
const info = await lastfm("user.getinfo");
const profile = {
  totalScrobbles: Number(info?.user?.playcount) || 0,
  registeredAt: toIso(info?.user?.registered?.unixtime),
  url: info?.user?.url || `https://www.last.fm/user/${USER}`,
};

// --- top artists: overall + this month ---
const topArtistsOverall = await lastfm("user.gettopartists", { period: "overall", limit: 12 });
const topArtistsMonth = await lastfm("user.gettopartists", { period: "1month", limit: 8 });

function mapArtists(json) {
  const arr = json?.topartists?.artist;
  return (Array.isArray(arr) ? arr : arr ? [arr] : []).map((a) => ({
    name: a.name,
    playcount: Number(a.playcount) || 0,
    url: a.url || null,
  }));
}

// --- top tracks ---
const topTracksJson = await lastfm("user.gettoptracks", { period: "overall", limit: 12 });
const topTracksArr = topTracksJson?.toptracks?.track;
const topTracks = (Array.isArray(topTracksArr) ? topTracksArr : topTracksArr ? [topTracksArr] : []).map((t) => ({
  name: t.name,
  artist: t.artist?.name || "",
  playcount: Number(t.playcount) || 0,
  url: t.url || null,
}));

// --- top albums ---
const topAlbumsJson = await lastfm("user.gettopalbums", { period: "overall", limit: 8 });
const topAlbumsArr = topAlbumsJson?.topalbums?.album;
const topAlbums = (Array.isArray(topAlbumsArr) ? topAlbumsArr : topAlbumsArr ? [topAlbumsArr] : []).map((a) => {
  // Last.fm still serves real cover art for albums (unlike artist photos,
  // which they stopped licensing years ago) — take the largest variant.
  const images = Array.isArray(a.image) ? a.image : [];
  const image = images.filter((im) => im["#text"]).pop()?.["#text"] || null;
  return {
    name: a.name,
    artist: a.artist?.name || "",
    playcount: Number(a.playcount) || 0,
    url: a.url || null,
    image,
  };
});

// --- top tracks per artist ---
//
// Last.fm has no "your top tracks BY this artist" endpoint — only
// user.getArtistTracks, which returns individual scrobble EVENTS, not an
// aggregate. So we fetch a bounded number of pages per artist and count
// track names ourselves. Bounded on purpose: a heavily-played artist could
// have thousands of scrobbles, and this only needs enough recent history to
// answer "what do you keep coming back to", not the complete archive.
const ARTIST_TRACK_PAGES = 3;

function normalizeArtistKey(name) {
  return (name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

async function topTracksForArtist(artistName) {
  const counts = new Map();
  for (let page = 1; page <= ARTIST_TRACK_PAGES; page++) {
    const json = await lastfm("user.getartisttracks", { artist: artistName, limit: 200, page }).catch((err) => {
      console.warn(`getArtistTracks failed for "${artistName}" page ${page}: ${err.message}`);
      return null;
    });
    if (!json) break;
    const arr = json?.artisttracks?.track;
    const tracks = Array.isArray(arr) ? arr : arr ? [arr] : [];
    if (!tracks.length) break;
    for (const t of tracks) {
      if (!t?.name) continue;
      counts.set(t.name, (counts.get(t.name) || 0) + 1);
    }
    const totalPages = Number(json?.artisttracks?.["@attr"]?.totalPages) || 1;
    if (page >= totalPages) break;
  }
  return [...counts.entries()]
    .map(([name, playcount]) => ({ name, playcount }))
    .sort((a, b) => b.playcount - a.playcount)
    .slice(0, 8);
}

// --- recent tracks ---
const recentJson = await lastfm("user.getrecenttracks", { limit: 12 });
const recentArr = recentJson?.recenttracks?.track;
const recentTracks = (Array.isArray(recentArr) ? recentArr : recentArr ? [recentArr] : [])
  // The currently-playing entry (if any) has no date and an
  // @attr.nowplaying flag — that's what Mirror already shows live, so it's
  // excluded here to avoid saying the same thing twice.
  .filter((t) => t.date?.uts)
  .map((t) => ({
    name: t.name,
    artist: t.artist?.["#text"] || "",
    playedAt: toIso(t.date.uts),
  }));

// --- top tracks per artist, for every artist that appears above ---
const artistNamesToExpand = new Map(); // key -> display name
for (const a of [...mapArtists(topArtistsOverall), ...mapArtists(topArtistsMonth)]) {
  const key = normalizeArtistKey(a.name);
  if (!artistNamesToExpand.has(key)) artistNamesToExpand.set(key, a.name);
}
console.log(`Fetching per-artist top tracks for ${artistNamesToExpand.size} artists...`);
const topTracksByArtist = {};
for (const [key, displayName] of artistNamesToExpand) {
  topTracksByArtist[key] = await topTracksForArtist(displayName);
}

const output = {
  $schema: "Listening Mirror Identity v1",
  meta: { lastUpdated: new Date().toISOString(), lastfmUser: USER },
  profile,
  topArtistsOverall: mapArtists(topArtistsOverall),
  topArtistsMonth: mapArtists(topArtistsMonth),
  topTracksByArtist,
  topTracks,
  topAlbums,
  recentTracks,
};

await writeFile(OUT, JSON.stringify(output, null, 2) + "\n");
console.log(
  `Wrote data/identity.json — ${profile.totalScrobbles} scrobbles, ` +
  `${output.topArtistsOverall.length} top artists, ${output.topTracks.length} top tracks, ` +
  `${output.topAlbums.length} top albums, ${output.recentTracks.length} recent plays.`
);