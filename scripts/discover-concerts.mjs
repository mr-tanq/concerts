#!/usr/bin/env node
// discover-concerts.mjs
//
// A RECOMMENDATION engine, not an auto-planner. It never writes
// data/planned.json — the only path from "recommendation" to "planned" is
// an explicit user decision (swipe in the app, or the Plan concert Action).
//
// Pipeline:
//   1. Last.fm listening signal (artists above minPlaycountToTrack)
//   2. Crawl Podiuminfo per-day agenda pages over the lookahead window
//   3. One recommendation per Podiuminfo concert id, matched against ALL
//      tracked artists at once
//   4. Score, exclude previously dismissed/planned/attended, publish
//
// PUBLICATION SAFETY — the run ends in one of three states:
//   SUCCESS  — crawl essentially complete; publish.
//   DEGRADED — some days served stale or a few concerts failed; publish,
//              but say so loudly in the log.
//   FAILED   — the listening signal is unavailable, or too much of the
//              crawl is missing to trust the result. DO NOT publish; the
//              previous recommendations.json is left untouched.
// The guiding rule: an upstream outage must never be silently recorded as
// "you have no recommendations".
//
// Required secrets:
//   LASTFM_API_KEY, LASTFM_USER
//
// FORCE_REFRESH_DAYS=true bypasses day-cache freshness checks (without
// discarding the cache — entries are replaced only on successful fetch).

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  discoverEvents,
  normalizeArtistName,
} from "./sources/podiuminfo.mjs";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const DAY_CACHE_PATH = path.join(ROOT, "data/podiuminfo-day-cache.json");
const CONCERT_CACHE_PATH = path.join(ROOT, "data/podiuminfo-cache.json");
const RECS_PATH = path.join(ROOT, "data/recommendations.json");

// Publish thresholds — a crawl missing more than this fraction of days is
// too incomplete to overwrite a known-good file with.
const MAX_MISSING_DAY_FRACTION = 0.15;

async function loadJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

// Write via temp file + rename so a crash mid-write can't leave a
// half-written JSON file behind.
async function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, filePath);
}

const CONFIG = JSON.parse(await readFile(path.join(ROOT, "data/config.json"), "utf8"));
const ARCHIVE = JSON.parse(await readFile(path.join(ROOT, "data/archive.json"), "utf8"));
const HISTORY = JSON.parse(await readFile(path.join(ROOT, "data/recommendation-history.json"), "utf8"));

let DAY_CACHE = await loadJsonSafe(DAY_CACHE_PATH, { entries: {} });
if (!DAY_CACHE.entries) DAY_CACHE.entries = {};
let CONCERT_CACHE = await loadJsonSafe(CONCERT_CACHE_PATH, { entries: {} });
if (!CONCERT_CACHE.entries) CONCERT_CACHE.entries = {};
const EXISTING_RECS = await loadJsonSafe(RECS_PATH, { concerts: [] });

const FORCE_REFRESH = process.env.FORCE_REFRESH_DAYS === "true";
if (FORCE_REFRESH) {
  // NOTE: we deliberately do NOT clear the cache here. Clearing it up-front
  // meant a failing refresh left us with nothing at all; instead each entry
  // is replaced only once a fresh fetch succeeds.
  console.log("FORCE_REFRESH_DAYS=true — bypassing freshness checks (cache retained as fallback).");
}

// ---------- 1. Listening signal ----------

function backoffWithJitter(attempt, baseMs = 1000) {
  return Math.round(baseMs * 2 ** attempt * (0.7 + Math.random() * 0.6));
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const secs = Number(headerValue);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Retries transport errors AND retryable HTTP statuses, validates res.ok
// before parsing, and surfaces Last.fm's own JSON error payloads.
async function lastfmFetchJson(url, maxAttempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts - 1) {
          const delay = parseRetryAfter(res.headers.get("retry-after")) ?? backoffWithJitter(attempt);
          console.warn(`Last.fm HTTP ${res.status}, retrying in ${delay}ms (${attempt + 1}/${maxAttempts})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Last.fm HTTP ${res.status}`);
      }

      const json = await res.json();
      if (json && json.error) {
        throw new Error(`Last.fm API error ${json.error}: ${json.message || "unknown"}`);
      }
      return json;
    } catch (err) {
      lastError = err;
      const transient = err.name === "AbortError" || err.name === "TypeError" || /HTTP 5|HTTP 429|fetch failed|network/i.test(err.message);
      if (transient && attempt < maxAttempts - 1) {
        const delay = backoffWithJitter(attempt);
        console.warn(`Last.fm request failed (${err.message}), retrying in ${delay}ms (${attempt + 1}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  throw new Error(`Last.fm request failed after ${maxAttempts} attempts: ${lastError?.message || "unknown"}`);
}

async function getLastfmWeightedArtists() {
  const key = process.env.LASTFM_API_KEY;
  const user = process.env.LASTFM_USER;
  if (!key || !user) throw new Error("Last.fm not configured (set LASTFM_API_KEY and LASTFM_USER)");

  const topUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${user}&api_key=${key}&format=json&period=overall&limit=1000`;
  const recentUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${user}&api_key=${key}&format=json&limit=200`;

  const [top, recent] = await Promise.all([lastfmFetchJson(topUrl), lastfmFetchJson(recentUrl)]);

  const weighted = new Map();
  for (const a of top?.topartists?.artist || []) {
    weighted.set(normalizeArtistName(a.name), {
      name: a.name,
      playcount: Number(a.playcount) || 0,
      recentPlays: 0,
    });
  }
  for (const t of recent?.recenttracks?.track || []) {
    const name = t.artist?.["#text"];
    if (!name) continue;
    const k = normalizeArtistName(name);
    const entry = weighted.get(k) || { name, playcount: 0, recentPlays: 0 };
    entry.recentPlays += 1;
    weighted.set(k, entry);
  }

  const list = [...weighted.values()];
  if (list.length === 0) throw new Error("Last.fm returned no artists — refusing to treat that as a real empty library");

  const maxPlay = Math.max(1, ...list.map((a) => a.playcount));
  const maxRecent = Math.max(1, ...list.map((a) => a.recentPlays));
  return list.map((a) => ({
    ...a,
    frequencyScore: a.playcount / maxPlay,
    recencyScore: a.recentPlays / maxRecent,
  }));
}

// ---------- 2. Identity & migration ----------

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// Canonical id, stable across artist/venue/date text changes.
function makeRecId(concertId) {
  return `rec-podiuminfo-${concertId}`;
}

// The pre-migration id scheme was per-matched-artist, so one concert could
// have produced several. We regenerate all of them to check history, so a
// concert you already dismissed or planned under the old scheme stays gone.
function legacyRecIds(event) {
  return event.matchedTracked.map((artist) => `rec-${slug(artist)}-${slug(event.venue)}-${event.date}`);
}

function isExcluded(event, excludedIds) {
  if (excludedIds.has(makeRecId(event.concertId))) return true;
  return legacyRecIds(event).some((id) => excludedIds.has(id));
}

// Primary archive identity is source + sourceId; artist/date/venue is kept
// only as a fallback for records added before sourceId existed.
function alreadyInArchive(event, archiveConcerts) {
  return archiveConcerts.some((c) => {
    if (c.source === "podiuminfo" && c.sourceId && String(c.sourceId) === String(event.concertId)) return true;
    if (c.date !== event.date) return false;
    if (normalizeArtistName(c.venue) !== normalizeArtistName(event.venue)) return false;
    return event.matchedTracked.some((a) => normalizeArtistName(a) === normalizeArtistName(c.artist));
  });
}

// ---------- 3. Scoring ----------

function scoreEvent(event, signalByName, cfg) {
  const w = cfg.scoring.weights;
  const reasons = [];

  // Rank the tracked artists on this bill and score off the strongest one.
  const ranked = event.matchedTracked
    .map((name) => ({ name, signal: signalByName.get(normalizeArtistName(name)) || null }))
    .sort((a, b) => {
      const as = (a.signal?.frequencyScore ?? 0) + (a.signal?.recencyScore ?? 0);
      const bs = (b.signal?.frequencyScore ?? 0) + (b.signal?.recencyScore ?? 0);
      if (bs !== as) return bs - as;
      return a.name.localeCompare(b.name); // deterministic tie-break
    });

  const primary = ranked[0];
  let score = w.directArtistMatch;
  reasons.push(`Known artist: ${primary.name}`);

  if (primary.signal) {
    score += w.listeningFrequency * primary.signal.frequencyScore;
    score += w.listeningRecency * primary.signal.recencyScore;
    if (primary.signal.recencyScore > 0.3) reasons.push("Recently in rotation");
  }

  // A bill with several artists you track is genuinely more interesting
  // than one with a single match — small, capped bonus.
  if (ranked.length > 1) {
    score += Math.min((ranked.length - 1) * 4, 12);
    reasons.push(`${ranked.length} tracked artists on this bill`);
  }

  if (event.country === cfg.location.homeCountry) score += w.distanceBonus;

  score = Math.round(Math.min(100, score));
  const label =
    score >= 70 ? "Excellent match" : score >= 45 ? "Strong match" : score >= 25 ? "Possible match" : "Weak match";

  return {
    displayArtist: primary.name,
    match: {
      score,
      label,
      matchedBy: "direct",
      reason: reasons.join(" · "),
      matchedArtists: ranked.map((r) => r.name),
    },
  };
}

// ---------- 4. Cache pruning ----------

function pruneCaches({ today, lookaheadEnd, protectedConcertIds }) {
  const dayFloor = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const dayCeil = new Date(new Date(lookaheadEnd + "T00:00:00Z").getTime() + 30 * 86400000)
    .toISOString()
    .slice(0, 10);

  let removedDays = 0;
  for (const [dateStr, entry] of Object.entries(DAY_CACHE.entries)) {
    const malformed = !entry || !Array.isArray(entry.candidates) || !entry.checkedAt;
    if (malformed || dateStr < dayFloor || dateStr > dayCeil) {
      delete DAY_CACHE.entries[dateStr];
      removedDays++;
    }
  }

  const concertFloor = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  let removedConcerts = 0;
  for (const [concertId, entry] of Object.entries(CONCERT_CACHE.entries)) {
    if (protectedConcertIds.has(String(concertId))) continue;
    const malformed = !entry || !entry.date || !Array.isArray(entry.lineup);
    if (malformed || entry.date < concertFloor) {
      delete CONCERT_CACHE.entries[concertId];
      removedConcerts++;
    }
  }

  if (removedDays || removedConcerts) {
    console.log(`Pruned ${removedDays} day entries and ${removedConcerts} concert entries from caches.`);
  }
}

// ---------- 5. Main ----------

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const lookaheadEnd = new Date(Date.now() + CONFIG.discovery.lookaheadDays * 86400000)
    .toISOString()
    .slice(0, 10);

  // --- Listening signal: a failure here is fatal, never "no artists" ---
  let signals;
  try {
    signals = await getLastfmWeightedArtists();
  } catch (err) {
    console.error(`FAILED: could not load the listening signal — ${err.message}`);
    console.error("Refusing to publish: an upstream Last.fm outage must not be recorded as an empty library.");
    console.error("data/recommendations.json left untouched.");
    process.exit(1);
  }

  const signalByName = new Map(signals.map((s) => [normalizeArtistName(s.name), s]));
  const minPlaycount = CONFIG.discovery.minPlaycountToTrack ?? 0;
  const trackedArtistNames = signals.filter((s) => s.playcount > minPlaycount).map((s) => s.name);

  console.log(`Tracking ${trackedArtistNames.length} artists (playcount > ${minPlaycount}).`);
  console.log(`Crawling Podiuminfo day agenda ${today} → ${lookaheadEnd}...`);

  // --- Crawl ---
  let events = [];
  let stats;
  try {
    const result = await discoverEvents({
      trackedArtistNames,
      startDate: today,
      endDate: lookaheadEnd,
      dayCacheEntries: DAY_CACHE.entries,
      concertCacheEntries: CONCERT_CACHE.entries,
      forceRefresh: FORCE_REFRESH,
      // Checkpoint caches every ~30 days of crawling so a crash doesn't
      // throw away all the work, without writing after every request.
      onProgress: async () => {
        await writeJsonAtomic(DAY_CACHE_PATH, DAY_CACHE);
        await writeJsonAtomic(CONCERT_CACHE_PATH, CONCERT_CACHE);
      },
    });
    events = result.events;
    stats = result.stats;
  } catch (err) {
    console.error(`FAILED: crawl aborted — ${err.message}`);
    await writeJsonAtomic(DAY_CACHE_PATH, DAY_CACHE);
    await writeJsonAtomic(CONCERT_CACHE_PATH, CONCERT_CACHE);
    process.exit(1);
  }

  // --- Decide run status ---
  const missingFraction = stats.daysTotal ? stats.daysMissing / stats.daysTotal : 1;
  let status = "SUCCESS";
  if (missingFraction > MAX_MISSING_DAY_FRACTION) {
    status = "FAILED";
  } else if (stats.daysMissing > 0 || stats.daysStale > 0 || stats.concertsFailed > 0) {
    status = "DEGRADED";
  }

  if (status === "FAILED") {
    console.error(
      `FAILED: ${stats.daysMissing}/${stats.daysTotal} days unavailable ` +
      `(${Math.round(missingFraction * 100)}% > ${Math.round(MAX_MISSING_DAY_FRACTION * 100)}% limit).`
    );
    console.error("Refusing to publish a partial crawl over known-good data. Caches saved; recommendations untouched.");
    await writeJsonAtomic(DAY_CACHE_PATH, DAY_CACHE);
    await writeJsonAtomic(CONCERT_CACHE_PATH, CONCERT_CACHE);
    process.exit(1);
  }

  // --- Build recommendations: exactly one per concert id ---
  const excludedIds = new Set([...(HISTORY.dismissedIds || []), ...(HISTORY.plannedIds || [])]);
  const previousById = new Map((EXISTING_RECS.concerts || []).map((c) => [c.id, c]));
  const previousBySourceId = new Map(
    (EXISTING_RECS.concerts || []).filter((c) => c.sourceId).map((c) => [String(c.sourceId), c])
  );

  const nowIso = new Date().toISOString();
  const results = [];

  // Funnel counters — when the output is unexpectedly empty, these say
  // exactly which stage ate the events instead of leaving us guessing.
  const dropped = {
    outOfDateRange: 0,
    unknownCountryRejected: 0,
    alreadyInArchive: 0,
    previouslyHandled: 0,
    belowMinScore: 0,
    countryNotAllowed: 0,
  };

  for (const event of events) {
    if (!event.date || event.date < today || event.date > lookaheadEnd) { dropped.outOfDateRange++; continue; }

    // Country rule: NL always; BE only for high scores. An UNKNOWN country
    // is not silently promoted to NL — it's only kept if unknowns are
    // explicitly allowed in config.
    if (event.country === null && !CONFIG.location.allowUnknownCountry) { dropped.unknownCountryRejected++; continue; }

    if (alreadyInArchive(event, ARCHIVE.concerts)) { dropped.alreadyInArchive++; continue; }
    if (isExcluded(event, excludedIds)) { dropped.previouslyHandled++; continue; }

    const { displayArtist, match } = scoreEvent(event, signalByName, CONFIG);
    if (match.score < CONFIG.discovery.minScoreToShow) { dropped.belowMinScore++; continue; }

    const highScoreThreshold = CONFIG.location.highScoreThreshold ?? Infinity;
    const allowedCountries =
      match.score >= highScoreThreshold
        ? CONFIG.location.highScoreSearchCountries || CONFIG.location.searchCountries
        : CONFIG.location.searchCountries;
    if (event.country !== null && !allowedCountries.includes(event.country)) { dropped.countryNotAllowed++; continue; }

    const id = makeRecId(event.concertId);
    const prior = previousBySourceId.get(String(event.concertId)) || previousById.get(id);

    results.push({
      id,
      source: "podiuminfo",
      sourceId: event.concertId,
      artist: displayArtist,
      lineup: event.lineup,
      supportingArtists: event.lineup.filter((n) => normalizeArtistName(n) !== normalizeArtistName(displayArtist)),
      matchedArtists: event.matchedTracked,
      date: event.date,
      time: null,
      venue: event.venue || "Unknown venue",
      city: event.city || "Unknown city",
      country: event.country || "??",
      isFestival: false,
      image: event.image,
      ticketUrl: event.ticketUrl || null,
      sourceApis: ["podiuminfo"],
      sourceUrl: event.url,
      match,
      // discoveredAt is when we FIRST saw it — preserved across runs so
      // "new this week" stays meaningful. lastSeenAt is this crawl.
      discoveredAt: prior?.discoveredAt || nowIso,
      lastSeenAt: nowIso,
    });
  }

  results.sort((a, b) => b.match.score - a.match.score || a.date.localeCompare(b.date));

  // --- Prune caches (never drop anything still referenced) ---
  const protectedConcertIds = new Set(results.map((r) => String(r.sourceId)));
  for (const id of [...(HISTORY.dismissedIds || []), ...(HISTORY.plannedIds || [])]) {
    const m = String(id).match(/^rec-podiuminfo-(\d+)$/);
    if (m) protectedConcertIds.add(m[1]);
  }
  for (const c of ARCHIVE.concerts || []) {
    if (c.sourceId) protectedConcertIds.add(String(c.sourceId));
  }
  pruneCaches({ today, lookaheadEnd, protectedConcertIds });

  // --- Publish ---
  const output = {
    $schema: "Listening Mirror Recommendations Schema v2",
    meta: {
      lastUpdated: nowIso,
      generatedBy: "discover-concerts.mjs",
      runStatus: status,
      crawl: stats,
    },
    concerts: results,
  };

  await writeJsonAtomic(RECS_PATH, output);
  await writeJsonAtomic(DAY_CACHE_PATH, DAY_CACHE);
  await writeJsonAtomic(CONCERT_CACHE_PATH, CONCERT_CACHE);

  console.log(`${status}: wrote ${results.length} recommendations (one per concert).`);
  console.log(
    `Funnel: ${events.length} confirmed events → ` +
    `-${dropped.outOfDateRange} out of range, ` +
    `-${dropped.unknownCountryRejected} unknown country, ` +
    `-${dropped.alreadyInArchive} already attended, ` +
    `-${dropped.previouslyHandled} already dismissed/planned, ` +
    `-${dropped.belowMinScore} below min score, ` +
    `-${dropped.countryNotAllowed} country not allowed ` +
    `= ${results.length} published.`
  );
  console.log(
    `History holds ${(HISTORY.dismissedIds || []).length} dismissed and ` +
    `${(HISTORY.plannedIds || []).length} planned id(s).`
  );
  if (status === "DEGRADED") {
    console.warn(
      `DEGRADED — ${stats.daysStale} stale day(s), ${stats.daysMissing} missing day(s), ` +
      `${stats.concertsFailed} concert page(s) failed. Published anyway; results may be incomplete.`
    );
  }
}

main().catch((err) => {
  console.error("FAILED with unhandled error:", err);
  process.exit(1);
});
