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

// --- top tracks per artist, built from real scrobble history ---
//
// Last.fm deprecated user.getArtistTracks (error 27, confirmed against a
// live request — not an assumption), so "your top tracks by this artist"
// can no longer be asked for directly. Instead, a bounded window of actual
// recent scrobbles is fetched once below and grouped by artist locally.
// This also directly reuses the same fetch that produces recentTracks,
// rather than paying for it twice.
//
// Honest limitation: an artist with no scrobbles inside this window (i.e.
// nothing recent) will show no tracks in the app, even if you played them
// heavily years ago. Last.fm's remaining API gives no cheaper way to ask
// "everything you've ever played by X" — widening the window trades a
// slower job for deeper history, which can be revisited later if needed.
const RECENT_SCROBBLE_PAGES = 20;

function normalizeArtistKey(name) {
  return (name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

async function fetchRecentScrobbles(maxPages) {
  const scrobbles = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await lastfm("user.getrecenttracks", { limit: 200, page }).catch((err) => {
      console.warn(`getRecentTracks page ${page} failed: ${err.message}`);
      return null;
    });
    if (!json) break;
    const arr = json?.recenttracks?.track;
    const tracks = Array.isArray(arr) ? arr : arr ? [arr] : [];
    if (!tracks.length) break;
    scrobbles.push(...tracks);
    const totalPages = Number(json?.recenttracks?.["@attr"]?.totalPages) || 1;
    if (page >= totalPages) break;
  }
  return scrobbles;
}

// --- recent scrobbles: one fetch, used for both recentTracks and the
// per-artist breakdown ---
console.log(`Fetching up to ${RECENT_SCROBBLE_PAGES} pages of recent scrobbles...`);
const allScrobbles = await fetchRecentScrobbles(RECENT_SCROBBLE_PAGES);
console.log(`Fetched ${allScrobbles.length} scrobbles.`);

const recentTracks = allScrobbles
  // The currently-playing entry (if any) has no date and an
  // @attr.nowplaying flag — that's what Mirror already shows live, so it's
  // excluded here to avoid saying the same thing twice.
  .filter((t) => t.date?.uts)
  .slice(0, 12)
  .map((t) => ({
    name: t.name,
    artist: t.artist?.["#text"] || "",
    playedAt: toIso(t.date.uts),
  }));

const topTracksByArtistCounts = new Map(); // artistKey -> Map(trackName -> count)
for (const t of allScrobbles) {
  if (!t.date?.uts) continue; // skip now-playing
  const artistName = t.artist?.["#text"] || "";
  if (!artistName || !t.name) continue;
  const key = normalizeArtistKey(artistName);
  if (!topTracksByArtistCounts.has(key)) topTracksByArtistCounts.set(key, new Map());
  const trackMap = topTracksByArtistCounts.get(key);
  trackMap.set(t.name, (trackMap.get(t.name) || 0) + 1);
}
const topTracksByArtist = {};
for (const [key, trackMap] of topTracksByArtistCounts) {
  topTracksByArtist[key] = [...trackMap.entries()]
    .map(([name, playcount]) => ({ name, playcount }))
    .sort((a, b) => b.playcount - a.playcount)
    .slice(0, 8);
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