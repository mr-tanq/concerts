// insights.js
//
// SELF, reconceived: not a prettier Last.fm profile, an insight engine.
// Every sentence rendered here has a number behind it computed in this
// file — the poetic language is presentation; the underlying claim is
// always mathematically demonstrable from data/listening-timeseries.json
// (weekly per-artist playcounts, Last.fm's own server-computed charts)
// cross-referenced with the concert Archive.
//
// Layers, kept deliberately separate:
//   normalization  -> fullSeriesFor()
//   detectors      -> detectStayed / detectComebacks / detectObsessions /
//                      detectPostConcertSurge / detectConcertRevival
//   scoring        -> each detector attaches its own 0..1 score
//   selection       -> computeInsights() sorts + picks the strongest,
//                      non-redundant handful
//   editorial       -> labelFor() / templateFor()
//   presentation    -> renderInsights()
//
// Note: computeInsights()/renderInsights() (the flat list) are no longer
// wired into SELF's default page — self-timeline.js's 3 editorial moments
// replaced that role — but everything here stays exported and working,
// since the detectors themselves are exactly what self-timeline.js reuses.

import { actuallySeenArtistsOf } from "./archive-stats.js";

export function normalizeKey(name) {
  return (name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

// Last.fm and the Archive don't always agree on how much of a stage name
// to use — Last.fm's own artist database has "Gonzales" for the person
// this app's Archive correctly knows as "Chilly Gonzales". An exact key
// match misses this entirely. A plain substring check would be too loose
// (it would happily match "Muse" inside "Museum"), so this only accepts a
// match where the shorter name is a whole word, or whole leading/trailing
// word-sequence, of the longer one.
export function keysLikelyMatch(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return longer.startsWith(shorter + " ") || longer.endsWith(" " + shorter);
}

const SMALL_WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"];
export function spellSmall(n) { return SMALL_WORDS[n] || String(n); }

export function humanizeWeeks(weeks) {
  if (weeks < 8) return `${spellSmall(weeks)} week${weeks === 1 ? "" : "s"}`;
  const months = Math.round(weeks / 4.345);
  if (months < 20) return `${spellSmall(months)} month${months === 1 ? "" : "s"}`;
  const years = Math.round(weeks / 52.18);
  return `${spellSmall(years)} year${years === 1 ? "" : "s"}`;
}
export function humanizeDays(days) { return humanizeWeeks(Math.round(days / 7)); }

export function monthYear(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- normalization ----------
//
// The shape every detector actually works with: one artist's plays across
// EVERY known week in the dataset, zero-filled where they had none — so a
// gap is a real, countable silence, not just an absence of a key.
export function fullSeriesFor(artistEntry, weekStarts) {
  const weeksMap = artistEntry?.weeks || {};
  return weekStarts.map((weekStart) => ({ weekStart, playcount: weeksMap[weekStart] || 0 }));
}

function playsInWindow(series, startIso, endIso) {
  return series
    .filter((w) => w.weekStart >= startIso && w.weekStart < endIso)
    .reduce((s, w) => s + w.playcount, 0);
}

// ---------- detectors ----------
//
// Each returns a candidate object with its own type-appropriate score, or
// null. Thresholds below are deliberately conservative — this is meant to
// surface a handful of genuinely notable things, not flag everything that
// technically qualifies.

export function detectStayed(artistName, series) {
  const activeYears = new Set();
  for (const { weekStart, playcount } of series) {
    if (playcount > 0) activeYears.add(weekStart.slice(0, 4));
  }
  const years = [...activeYears].sort();
  const yearSpan = years.length;
  if (yearSpan < 5) return null;

  return {
    type: "stayed",
    artistName,
    years,
    yearSpan,
    firstYear: years[0],
    lastYear: years[years.length - 1],
    score: Math.min(1, yearSpan / 15),
  };
}

export function detectComebacks(artistName, series) {
  const MIN_GAP_WEEKS = 26;
  const MIN_RETURN_PLAYS = 5;
  const RETURN_WINDOW = 8;

  let bestGap = null;
  let i = 0;
  while (i < series.length) {
    if (series[i].playcount > 0) { i++; continue; }
    const gapStart = i;
    while (i < series.length && series[i].playcount === 0) i++;
    const gapEnd = i; // exclusive

    const hasActivityBefore = gapStart > 0;
    const hasActivityAfter = gapEnd < series.length;
    const gapLength = gapEnd - gapStart;

    if (hasActivityBefore && hasActivityAfter && gapLength >= MIN_GAP_WEEKS) {
      const returnPlays = series.slice(gapEnd, gapEnd + RETURN_WINDOW).reduce((s, w) => s + w.playcount, 0);
      if (returnPlays >= MIN_RETURN_PLAYS && (!bestGap || gapLength > bestGap.gapLength)) {
        bestGap = { gapLength, returnPlays, weekStartAfter: series[gapEnd].weekStart };
      }
    }
  }
  if (!bestGap) return null;

  return {
    type: "comeback",
    artistName,
    gapWeeks: bestGap.gapLength,
    returnWeekStart: bestGap.weekStartAfter,
    returnPlays: bestGap.returnPlays,
    score: Math.min(1, bestGap.gapLength / 104) * Math.min(1, bestGap.returnPlays / 20),
  };
}

export function detectObsessions(artistName, series) {
  const totalPlays = series.reduce((s, w) => s + w.playcount, 0);
  if (totalPlays < 15) return null;

  const MAX_WINDOW = 6;
  let best = null;
  for (let windowSize = 1; windowSize <= MAX_WINDOW; windowSize++) {
    for (let start = 0; start <= series.length - windowSize; start++) {
      const windowPlays = series.slice(start, start + windowSize).reduce((s, w) => s + w.playcount, 0);
      const share = windowPlays / totalPlays;
      if (share >= 0.3 && windowPlays >= 10 && (!best || share > best.share)) {
        best = { start, windowSize, windowPlays, share, weekStart: series[start].weekStart };
      }
    }
  }
  if (!best) return null;

  return {
    type: "obsession",
    artistName,
    windowWeeks: best.windowSize,
    windowStart: best.weekStart,
    windowPlays: best.windowPlays,
    share: best.share,
    score: Math.min(1, best.share) * Math.min(1, best.windowPlays / 40),
  };
}

// The two detectors below are the cross-reference layer — the thing no
// Last.fm profile page could ever tell you, because it doesn't know you
// stood in a room for this artist on a specific night.

export function detectPostConcertSurge(artistName, series, concertDate) {
  // "Barely listened before" has to mean the whole history, not just the
  // last two months — otherwise a longtime fan who'd simply gone quiet
  // recently reads as a brand-new discovery, which is the wrong story;
  // that shape belongs to detectConcertRevival instead.
  const totalBeforeEver = playsInWindow(series, series[0]?.weekStart || "0000-01-01", concertDate);
  const after = playsInWindow(series, concertDate, addDays(concertDate, 30));
  if (totalBeforeEver > 5 || after < 10) return null;

  return {
    type: "postConcertSurge",
    artistName,
    concertDate,
    beforePlays: totalBeforeEver,
    afterPlays: after,
    score: Math.min(1, after / 40) * (totalBeforeEver === 0 ? 1 : 0.8),
  };
}

export function detectConcertRevival(artistName, series, concertDate) {
  const dormantStart = addDays(concertDate, -730);
  const dormantWindow = playsInWindow(series, dormantStart, addDays(concertDate, -60));
  const priorActivity = series.some((w) => w.weekStart < dormantStart && w.playcount > 0);
  const after = playsInWindow(series, concertDate, addDays(concertDate, 60));

  if (!priorActivity || dormantWindow > 2 || after < 8) return null;

  let lastActiveBeforeDormancy = null;
  for (const w of series) {
    if (w.weekStart >= dormantStart) break;
    if (w.playcount > 0) lastActiveBeforeDormancy = w.weekStart;
  }
  if (!lastActiveBeforeDormancy) return null;

  const gapDays = Math.round((new Date(concertDate) - new Date(lastActiveBeforeDormancy)) / 86400000);
  return {
    type: "concertRevival",
    artistName,
    concertDate,
    gapDays,
    afterPlays: after,
    score: Math.min(1, gapDays / 730) * Math.min(1, after / 30),
  };
}

// ---------- editorial ----------

export function labelFor(type) {
  return {
    stayed: "The ones that stayed",
    comeback: "The comeback",
    obsession: "The obsession",
    postConcertSurge: "After seeing them live",
    concertRevival: "The show brought them back",
  }[type] || "";
}

export function templateFor(c) {
  switch (c.type) {
    case "stayed":
      return `${c.artistName} has appeared in your listening across ${spellSmall(c.yearSpan)} different years — ${c.firstYear} to ${c.lastYear}.`;
    case "comeback":
      return `You found your way back to ${c.artistName} after ${humanizeWeeks(c.gapWeeks)} away.`;
    case "obsession":
      return `For ${humanizeWeeks(c.windowWeeks)} in ${monthYear(c.windowStart)}, ${c.artistName} was almost all you played.`;
    case "postConcertSurge":
      return `You'd barely listened to ${c.artistName} before the show. In the month after, they never really left.`;
    case "concertRevival":
      return `You saw ${c.artistName} after ${humanizeDays(c.gapDays)} away. They came back into rotation afterward.`;
    default:
      return "";
  }
}

export function whenHintFor(c) {
  switch (c.type) {
    case "stayed": return null;
    case "comeback": return monthYear(c.returnWeekStart);
    case "obsession": return monthYear(c.windowStart);
    case "postConcertSurge": return monthYear(c.concertDate);
    case "concertRevival": return monthYear(c.concertDate);
    default: return null;
  }
}

// ---------- selection ----------

// Last.fm's own chart data carries whatever spelling was scrobbled, which
// can drift from the correctly-accented name already curated in the
// Archive (e.g. "Mum" vs "múm"). The Archive is treated as the source of
// truth for display names wherever the two overlap.
export function buildCanonicalNameIndex(archiveConcerts) {
  const index = new Map();
  for (const c of archiveConcerts || []) {
    for (const n of actuallySeenArtistsOf(c)) {
      const key = normalizeKey(n);
      if (!index.has(key)) index.set(key, n);
    }
  }
  return index;
}

// Fuzzy fallback for finding this artist's Last.fm entry when the exact
// normalized key isn't present — same word-boundary rule as keysLikelyMatch.
export function findArtistEntry(artists, rawName) {
  const key = normalizeKey(rawName);
  if (artists[key]) return artists[key];
  for (const entryKey of Object.keys(artists)) {
    if (keysLikelyMatch(key, entryKey)) return artists[entryKey];
  }
  return null;
}

export function canonicalNameFor(canonicalNames, rawName) {
  const key = normalizeKey(rawName);
  if (canonicalNames.has(key)) return canonicalNames.get(key);
  for (const [indexKey, name] of canonicalNames.entries()) {
    if (keysLikelyMatch(key, indexKey)) return name;
  }
  return rawName;
}

export function computeInsights(timeseries, archiveConcerts, options = {}) {
  const maxInsights = options.maxInsights ?? 6;
  const weekStarts = timeseries?.meta?.weekStarts || [];
  if (!weekStarts.length) return [];

  const artists = timeseries.artists || {};
  const canonicalNames = buildCanonicalNameIndex(archiveConcerts);
  const candidates = [];

  // Concert-aware candidates go first: when a listening pattern can be
  // explained by a specific night, that story is strictly more complete
  // than a same-shaped but context-free "obsession" for the same burst —
  // so artists explained by a concert are tracked and the generic
  // obsession detector is skipped for them below, rather than leaving two
  // true-but-competing descriptions of the same event to fight on score.
  const explainedByConcert = new Set();
  for (const concert of archiveConcerts || []) {
    if (!concert.date) continue;
    for (const name of actuallySeenArtistsOf(concert)) {
      const entry = findArtistEntry(artists, name);
      if (!entry) continue;
      const series = fullSeriesFor(entry, weekStarts);
      // 'name' here is already the Archive's own spelling — the most
      // authoritative one available, no lookup needed.
      const surge = detectPostConcertSurge(name, series, concert.date);
      if (surge) { candidates.push(surge); explainedByConcert.add(normalizeKey(name)); }
      const revival = detectConcertRevival(name, series, concert.date);
      if (revival) { candidates.push(revival); explainedByConcert.add(normalizeKey(name)); }
    }
  }

  for (const entry of Object.values(artists)) {
    const series = fullSeriesFor(entry, weekStarts);
    const displayName = canonicalNameFor(canonicalNames, entry.name);
    const stayed = detectStayed(displayName, series);
    if (stayed) candidates.push(stayed);
    if (!explainedByConcert.has(normalizeKey(entry.name))) {
      const comeback = detectComebacks(displayName, series);
      if (comeback) candidates.push(comeback);
      const obsession = detectObsessions(displayName, series);
      if (obsession) candidates.push(obsession);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  // Capped per type — 'stayed' has a structural scoring advantage on any
  // long-running account (many artists naturally clear 5+ years), so
  // without this the strongest 6 could all be the same kind of sentence.
  // Better to show fewer, more varied insights than six near-duplicates.
  const MAX_PER_TYPE = 2;
  const seenArtists = new Set();
  const typeCounts = new Map();
  const selected = [];
  for (const c of candidates) {
    const key = normalizeKey(c.artistName);
    if (seenArtists.has(key)) continue;
    const typeCount = typeCounts.get(c.type) || 0;
    if (typeCount >= MAX_PER_TYPE) continue;
    seenArtists.add(key);
    typeCounts.set(c.type, typeCount + 1);
    selected.push(c);
    if (selected.length >= maxInsights) break;
  }
  return selected;
}

// ---------- presentation ----------

export function renderInsights(root, insights, deps) {
  const { el, esc } = deps;
  root.innerHTML = "";

  if (!insights.length) {
    root.appendChild(el(`
      <div class="insight-empty">
        <p class="footnote">Still gathering — insights need enough listening history behind them to say something real, not just plausible.</p>
      </div>
    `));
    return;
  }

  insights.forEach((ins, i) => {
    const when = whenHintFor(ins);
    const entry = el(`
      <div class="insight-entry" style="animation-delay:${i * 100}ms">
        <p class="whisper">${esc(labelFor(ins.type))}</p>
        <p class="lede insight-sentence">${esc(templateFor(ins))}</p>
        ${when ? `<p class="insight-when">${esc(when)}</p>` : ""}
      </div>
    `);
    root.appendChild(entry);
  });
}