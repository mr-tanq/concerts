#!/usr/bin/env node
// discover-concerts.mjs
//
// This is a RECOMMENDATION engine, not an auto-planner. It never touches
// data/planned.json. It:
//   1. Reads your Last.fm listening signal
//   2. Builds a ranked, weighted list of artists you actually listen to
//   3. Searches Podiuminfo's event database for each artist (NL/BE only)
//   4. Scores the results
//   5. Excludes anything you've already dismissed or planned before
//   6. Merges the refreshed results into data/recommendations.json
//
// TIERED DISCOVERY (architecture decision, not a shortcut):
// We never trust Podiuminfo's search-results listing — every candidate
// concert's own page gets fetched and parsed for the authoritative date/
// venue/city (see scripts/sources/podiuminfo.mjs for why). That's correct,
// but doing it for all 200 tracked artists on every run is slow. Instead:
//   - DISCOVERY_TIER=top  (default, runs on the frequent schedule) checks
//     only your top N artists by listening score — these are the ones
//     most likely to have something new, so they're worth checking often.
//   - DISCOVERY_TIER=full (runs weekly) checks the long tail (everyone
//     past rank N) — lower priority, doesn't need daily freshness.
// Each run only re-searches ITS OWN tier's artists and merges the result
// back into recommendations.json, leaving the other tier's entries
// untouched — so the daily "top" run can never wipe out what the weekly
// "full" run found, and vice versa.
//
// CACHING: data/podiuminfo-cache.json remembers the parsed result of every
// concert page we've already opened (keyed by Podiuminfo's concert id). If
// we encounter the same concert id again within the freshness window, we
// skip fetching it a second time — same authoritative source, we just
// don't ask twice. This is the single biggest speed win, since most
// concerts appear across many artist searches unchanged run after run.
//
// Required secrets (set in repo Settings > Secrets and variables > Actions):
//   LASTFM_API_KEY   - https://www.last.fm/api/account/create
//   LASTFM_USER      - your Last.fm username

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { queryPodiuminfo } from "./sources/podiuminfo.mjs";

async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt >= retries) throw err;
      const delayMs = 500 * 2 ** attempt;
      console.warn(`fetch failed (${err.message}), retrying in ${delayMs}ms... (${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const CONFIG = JSON.parse(await readFile(path.join(ROOT, "data/config.json"), "utf8"));
const ARCHIVE = JSON.parse(await readFile(path.join(ROOT, "data/archive.json"), "utf8"));
const HISTORY = JSON.parse(await readFile(path.join(ROOT, "data/recommendation-history.json"), "utf8"));

const CACHE_PATH = path.join(ROOT, "data/podiuminfo-cache.json");
let CACHE;
try {
  CACHE = JSON.parse(await readFile(CACHE_PATH, "utf8"));
} catch {
  CACHE = { $schema: "Listening Mirror Podiuminfo Cache v1", entries: {} };
}
if (!CACHE.entries) CACHE.entries = {};

const TIER = (process.env.DISCOVERY_TIER || "top").toLowerCase(); // "top" | "full"

// ---------- 1. Listening signal ----------

async function getLastfmWeightedArtists() {
  const key = process.env.LASTFM_API_KEY;
  const user = process.env.LASTFM_USER;
  if (!key || !user) {
    console.warn("Last.fm not configured — skipping (set LASTFM_API_KEY, LASTFM_USER)");
    return [];
  }

  const topUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${user}&api_key=${key}&format=json&period=overall&limit=200`;
  const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${user}&api_key=${key}&format=json&limit=200`;

  const [topRes, recentRes] = await Promise.all([fetchWithRetry(topUrl), fetchWithRetry(recentUrl)]);
  const top = await topRes.json();
  const recent = await recentRes.json();

  const weighted = new Map();

  for (const a of top?.topartists?.artist || []) {
    weighted.set(a.name.toLowerCase(), {
      name: a.name,
      playcount: Number(a.playcount) || 0,
      recentPlays: 0,
    });
  }
  for (const t of recent?.recenttracks?.track || []) {
    const name = t.artist?.["#text"];
    if (!name) continue;
    const key2 = name.toLowerCase();
    const entry = weighted.get(key2) || { name, playcount: 0, recentPlays: 0 };
    entry.recentPlays += 1;
    weighted.set(key2, entry);
  }

  const list = [...weighted.values()];
  const maxPlay = Math.max(1, ...list.map((a) => a.playcount));
  const maxRecent = Math.max(1, ...list.map((a) => a.recentPlays));
  return list.map((a) => ({
    ...a,
    frequencyScore: a.playcount / maxPlay,
    recencyScore: a.recentPlays / maxRecent,
  }));
}

// ---------- 2. Concert sources ----------

const SOURCE_ADAPTERS = {
  podiuminfo: (artist) => queryPodiuminfo(artist, CACHE.entries),
};

// ---------- 3. Scoring ----------

function scoreEvent(event, artistSignal, cfg) {
  const w = cfg.scoring.weights;
  let score = 0;
  let reasons = [];

  score += w.directArtistMatch;
  reasons.push(`Known artist: ${event.artist}`);

  if (artistSignal) {
    score += w.listeningFrequency * artistSignal.frequencyScore;
    score += w.listeningRecency * artistSignal.recencyScore;
    if (artistSignal.recencyScore > 0.3) reasons.push("Recently in rotation");
  }

  const homeCountry = cfg.location.homeCountry;
  if (event.country === homeCountry) score += w.distanceBonus;

  score = Math.round(Math.min(100, score));
  const label = score >= 70 ? "Excellent match" : score >= 45 ? "Strong match" : score >= 25 ? "Possible match" : "Weak match";

  return {
    score,
    label,
    matchedBy: "direct",
    reason: reasons.join(" · "),
    matchedArtists: [event.artist],
  };
}

function alreadyInArchive(event, archiveConcerts) {
  return archiveConcerts.some(
    (c) =>
      c.artist.toLowerCase() === event.artist.toLowerCase() &&
      c.date === event.date &&
      c.venue?.toLowerCase() === event.venue?.toLowerCase()
  );
}

function makeId(event) {
  const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `rec-${slug(event.artist)}-${slug(event.venue)}-${event.date}`;
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  async function next() {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  }
  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(lanes);
}

// ---------- 4. Main ----------

async function main() {
  let signals = [];
  try {
    signals = await getLastfmWeightedArtists();
  } catch (err) {
    console.error(`Last.fm fetch failed after retries: ${err.message}`);
    console.warn("Continuing with no listening signal — this tier's results will end up empty this run.");
  }
  const signalByName = new Map(signals.map((s) => [s.name.toLowerCase(), s]));

  const rankedNames = signals
    .sort((a, b) => (b.frequencyScore + b.recencyScore) - (a.frequencyScore + a.recencyScore))
    .map((s) => s.name);

  const topTierSize = CONFIG.discovery.topTierSize ?? 30;
  const candidateArtists = TIER === "full"
    ? rankedNames.slice(topTierSize, 200)
    : rankedNames.slice(0, topTierSize);

  console.log(`Tier: ${TIER} — querying concert sources for ${candidateArtists.length} artists...`);
  console.log(`Candidate artists: ${candidateArtists.join(", ")}`);

  const activeSources = CONFIG.discovery.concertApis.filter((s) => SOURCE_ADAPTERS[s]);
  const rawEvents = [];
  await runWithConcurrency(candidateArtists, 4, async (artist) => {
    for (const source of activeSources) {
      try {
        const events = await SOURCE_ADAPTERS[source](artist);
        rawEvents.push(...events);
      } catch (err) {
        console.warn(`Skipping "${artist}" on ${source}: ${err.message}`);
      }
    }
  });

  const excludedIds = new Set([...HISTORY.dismissedIds, ...HISTORY.plannedIds]);
  const seen = new Set();
  const freshResults = [];
  const today = new Date().toISOString().slice(0, 10);
  const lookaheadCutoff = new Date(Date.now() + CONFIG.discovery.lookaheadDays * 86400000)
    .toISOString()
    .slice(0, 10);

  for (const event of rawEvents) {
    if (!event.date || event.date < today || event.date > lookaheadCutoff) continue;
    if (!CONFIG.location.searchCountries.includes(event.country)) continue;
    if (alreadyInArchive(event, ARCHIVE.concerts)) continue;

    const id = makeId(event);
    if (seen.has(id)) continue;
    if (excludedIds.has(id)) continue;
    seen.add(id);

    const match = scoreEvent(event, signalByName.get(event.artist.toLowerCase()), CONFIG);
    if (match.score < CONFIG.discovery.minScoreToShow) continue;

    freshResults.push({
      id,
      artist: event.artist,
      supportingArtists: event.supportingArtists || [],
      date: event.date,
      time: event.time || null,
      venue: event.venue || "Unknown venue",
      city: event.city || "Unknown city",
      country: event.country || "??",
      isFestival: false,
      image: event.image,
      ticketUrl: event.ticketUrl || null,
      sourceApis: [event.source],
      match,
      discoveredAt: new Date().toISOString(),
    });
  }

  let existing = { concerts: [] };
  try {
    existing = JSON.parse(await readFile(path.join(ROOT, "data/recommendations.json"), "utf8"));
  } catch {
    // no existing file yet — fine, starts empty
  }
  const refreshedArtistSet = new Set(candidateArtists.map((a) => a.toLowerCase()));
  const keptFromOtherTier = (existing.concerts || []).filter(
    (c) => !refreshedArtistSet.has((c.artist || "").toLowerCase())
  );
  const merged = [...keptFromOtherTier, ...freshResults];
  merged.sort((a, b) => b.match.score - a.match.score);

  const output = {
    $schema: "Listening Mirror Recommendations Schema v1",
    meta: { lastUpdated: new Date().toISOString(), generatedBy: "discover-concerts.mjs", lastTierRun: TIER },
    concerts: merged,
  };

  await writeFile(path.join(ROOT, "data/recommendations.json"), JSON.stringify(output, null, 2) + "\n");
  await writeFile(CACHE_PATH, JSON.stringify(CACHE, null, 2) + "\n");

  console.log(`Tier "${TIER}": ${freshResults.length} fresh matches, ${merged.length} total after merge.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});