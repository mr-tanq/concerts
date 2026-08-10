#!/usr/bin/env node
// fetch-listening-history.mjs
//
// Backfills, then incrementally updates, a per-artist weekly playcount
// timeseries — the raw material the SELF insight engine reasons over.
//
// Deliberately built on user.getWeeklyChartList + user.getWeeklyArtistChart
// rather than paginating raw scrobbles: Last.fm already computes ranked
// weekly artist charts, server-side, for a user's ENTIRE history. That's a
// far cheaper and more complete source for "how has this artist's
// listening moved across years" than reconstructing it ourselves from
// tens of thousands of individual scrobbles — and it's the same data
// last.fm's own "weekly listening trend" charts are built from.
//
// Runs incrementally: each run fetches up to MAX_WEEKS_PER_RUN weeks it
// hasn't already stored, then stops — safe to re-run on a schedule until
// the full history is backfilled, after which it just keeps pace with new
// weeks as they appear.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const OUT = path.join(ROOT, "data/listening-timeseries.json");

const API_KEY = process.env.LASTFM_API_KEY;
const USERNAME = process.env.LASTFM_USER;
const BASE = "https://ws.audioscrobbler.com/2.0/";

const MIN_GAP_MS = 260;        // stays comfortably under Last.fm's ~5 req/sec guidance
const MAX_WEEKS_PER_RUN = 180; // keeps one run well within normal CI time; resumes next run
const TOP_N_PER_WEEK = 40;     // enough for meaningful analysis without unbounded file growth

let lastCall = 0;
async function throttle() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function call(method, params = {}, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await throttle();
    const url = new URL(BASE);
    url.searchParams.set("method", method);
    url.searchParams.set("user", USERNAME);
    url.searchParams.set("api_key", API_KEY);
    url.searchParams.set("format", "json");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`Last.fm error ${json.error}: ${json.message || ""}`);
      return json;
    } catch (err) {
      if (attempt === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

export function normalizeArtistKey(name) {
  return (name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

// Pure — the actual per-week merge logic, kept separate from network code
// so it can be unit tested with synthetic Last.fm responses.
export function mergeWeekIntoStore(store, weekStartIso, rawArtists, topN = TOP_N_PER_WEEK) {
  const top = rawArtists
    .map((a) => ({ name: a.name, playcount: Number(a.playcount || 0) }))
    .filter((a) => a.name && a.playcount > 0)
    .sort((a, b) => b.playcount - a.playcount)
    .slice(0, topN);

  for (const { name, playcount } of top) {
    const key = normalizeArtistKey(name);
    if (!key) continue;
    if (!store.artists[key]) store.artists[key] = { name, weeks: {} };
    store.artists[key].weeks[weekStartIso] = playcount;
  }
  return store;
}

async function loadJson(rel, fallback) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, rel), "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  if (!API_KEY || !USERNAME) {
    console.error("Missing LASTFM_API_KEY or LASTFM_USER environment variable.");
    process.exit(1);
  }

  const store = await loadJson("data/listening-timeseries.json", {
    $schema: "Listening Mirror Timeseries v1",
    meta: { lastUpdated: null, weeksFetched: 0, weeksAvailable: 0, backfillComplete: false, doneWeeks: [], weekStarts: [] },
    artists: {},
  });
  if (!Array.isArray(store.meta.doneWeeks)) store.meta.doneWeeks = [];
  if (!Array.isArray(store.meta.weekStarts)) store.meta.weekStarts = [];

  const chartListRes = await call("user.getweeklychartlist");
  const allWeeks = (chartListRes.weeklychartlist?.chart || []).map((c) => ({
    from: Number(c.from), to: Number(c.to),
  }));

  const doneFroms = new Set(store.meta.doneWeeks);
  const pending = allWeeks.filter((w) => !doneFroms.has(String(w.from)));
  console.log(`${allWeeks.length} weeks total on Last.fm; ${pending.length} not yet fetched.`);

  const batch = pending.slice(0, MAX_WEEKS_PER_RUN);
  let fetched = 0;

  for (const week of batch) {
    const weekStartIso = new Date(week.from * 1000).toISOString().slice(0, 10);
    try {
      const res = await call("user.getweeklyartistchart", { from: week.from, to: week.to });
      const artists = res.weeklyartistchart?.artist || [];
      mergeWeekIntoStore(store, weekStartIso, artists);
      store.meta.doneWeeks.push(String(week.from));
      store.meta.weekStarts.push(weekStartIso);
      fetched++;
    } catch (err) {
      console.warn(`Week starting ${weekStartIso} failed: ${err.message} — will retry next run.`);
      break; // stop cleanly on first failure this run; resume from here next time
    }
  }

  store.meta.weeksAvailable = allWeeks.length;
  store.meta.weeksFetched = store.meta.doneWeeks.length;
  store.meta.backfillComplete = store.meta.weeksFetched >= allWeeks.length;
  store.meta.weekStarts = [...new Set(store.meta.weekStarts)].sort();
  store.meta.lastUpdated = new Date().toISOString();

  await writeFile(OUT, JSON.stringify(store, null, 2) + "\n");
  console.log(
    `Fetched ${fetched} weeks this run. ${store.meta.weeksFetched}/${allWeeks.length} total ` +
    `(${store.meta.backfillComplete ? "backfill complete" : "continuing next run"}).`
  );
}

// Only run when executed directly — lets tests import mergeWeekIntoStore
// and normalizeArtistKey without triggering a live fetch.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}