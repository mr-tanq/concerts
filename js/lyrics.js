// lyrics.js
//
// lrclib.net is a free, keyless, crowdsourced lyrics database with CORS
// enabled specifically for browser use — confirmed directly against their
// docs, no proxy needed. Coverage is inconsistent (it's community-
// submitted), so every call here is expected to sometimes come back empty,
// and that's treated as a normal, silent outcome, not an error.
//
// Nothing in this file ever hands back more than one line at a time to the
// UI — see currentLine() — so the app never holds, and never has reason to
// display, a full copyrighted lyric sheet at once.

const cache = new Map();

/** LRCLIB's own matching tolerance for the strict /api/get endpoint. */
export const DURATION_TOLERANCE_SEC = 2;

/**
 * Beyond this, a candidate is a different recording — a live take, an
 * extended mix, a full-album upload — not a timing variation. Synced lyrics
 * from such a version are wrong for the entire song, which is a visibly
 * broken experience; showing nothing is the better outcome. Generous on
 * purpose so genuine edits/remasters still match.
 */
export const MAX_DURATION_DELTA_SEC = 60;

function normalize(s) {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Cache key includes the rounded duration (and album when known).
 *
 * Without duration in the key, a 3:14 single edit and a 7:41 album version
 * of the same artist+track would share one cache entry, so whichever played
 * first would silently supply its lyrics — and its timings — to the other
 * for the rest of the session. That is exactly the version-collision this
 * lookup now works to avoid, so it must not be reintroduced by the cache.
 */
export function cacheKey(artist, track, album, durationSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0
    ? String(Math.round(durationSec))
    : "nodur";
  return `${normalize(artist)}::${normalize(track)}::${normalize(album)}::${dur}`;
}

// "[00:17.12] text" -> { ms: 17120, text: "text" }. Lines without a
// timestamp (rare, malformed entries) are dropped rather than guessed at.
function parseLrc(synced) {
  const lines = [];
  for (const raw of synced.split("\n")) {
    const m = raw.match(/^\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/);
    if (!m) continue;
    const [, mm, ss, frac, text] = m;
    const ms = (Number(mm) * 60 + Number(ss)) * 1000 + Number((frac || "0").padEnd(3, "0"));
    if (text.trim()) lines.push({ ms, text: text.trim() });
  }
  return lines.sort((a, b) => a.ms - b.ms);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "Accept": "application/json" } });
    if (res.status === 404) return null; // "not found" is a normal answer here
    if (!res.ok) throw new Error(`lrclib HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pick the best synced candidate from a search response.
 *
 * The previous implementation was `results.find(r => r.syncedLyrics)` — the
 * FIRST synced hit, in whatever order lrclib happened to return. For a track
 * with a single edit, an album version, a live cut and a remaster, that
 * routinely selects a version whose timings drift further and further out as
 * the song plays.
 *
 * Ordering, strongest signal first:
 *   1. normalized exact artist + track match
 *   2. within LRCLIB's own ±2s duration tolerance
 *   3. smallest absolute duration difference
 *
 * Exact artist/track outranks duration deliberately: a duration coincidence
 * between two different songs is far more likely than an exact
 * artist+title match being the wrong song.
 *
 * Exported for testing.
 */
export function pickBestSyncedResult(results, { artist, track, durationSec }) {
  if (!Array.isArray(results)) return null;
  const synced = results.filter((r) => r && r.syncedLyrics);
  if (!synced.length) return null;

  // No duration to compare against: preserve the previous, sensible
  // behaviour — prefer an exact artist/track match if one exists, otherwise
  // the first synced result, exactly as before.
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    const wantArtist = normalize(artist);
    const wantTrack = normalize(track);
    return synced.find(
      (r) => normalize(r.artistName) === wantArtist && normalize(r.trackName) === wantTrack
    ) || synced[0];
  }

  const wantArtist = normalize(artist);
  const wantTrack = normalize(track);

  const scored = synced.map((r) => {
    const dur = Number(r.duration);
    const hasDuration = Number.isFinite(dur) && dur > 0;
    const delta = hasDuration ? Math.abs(dur - durationSec) : Number.POSITIVE_INFINITY;
    return {
      result: r,
      exact: normalize(r.artistName) === wantArtist && normalize(r.trackName) === wantTrack,
      within: delta <= DURATION_TOLERANCE_SEC,
      delta,
    };
  });

  scored.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.within !== b.within) return a.within ? -1 : 1;
    return a.delta - b.delta;
  });

  const best = scored[0];
  // A candidate with no usable duration at all still beats nothing, but a
  // wildly different one does not.
  if (Number.isFinite(best.delta) && best.delta > MAX_DURATION_DELTA_SEC) return null;
  return best.result;
}

// Fetches once per (artist, track, album, duration) combination per session
// and caches the result — including negative results, so a song lrclib
// doesn't have isn't re-requested every 5 seconds while it keeps playing.
export async function getSyncedLyrics({ artist, track, album, durationSec }) {
  const key = cacheKey(artist, track, album, durationSec);
  if (cache.has(key)) return cache.get(key);

  let result = { lines: null };
  try {
    // LRCLIB /api/get requires the COMPLETE track signature: track, artist,
    // album and duration. Android/YouTube often has no album at all, so
    // calling /api/get in that case is not merely unlikely to match -- it is
    // an invalid request according to LRCLIB's API contract. Go straight to
    // /api/search when the full signature is unavailable.
    const hasExactSignature = !!album && Number.isFinite(durationSec) && durationSec > 0;
    let hit = null;

    if (hasExactSignature) {
      const params = new URLSearchParams({
        track_name: track,
        artist_name: artist,
        album_name: album,
        duration: String(Math.round(durationSec)),
      });
      hit = await fetchJson(`https://lrclib.net/api/get?${params}`);
    }

    // The exact-match endpoint is strict (album/duration must line up
    // closely); fall back to search, which is looser, before giving up.
    if (!hit?.syncedLyrics) {
      const searchParams = new URLSearchParams({ track_name: track, artist_name: artist });
      const results = await fetchJson(`https://lrclib.net/api/search?${searchParams}`);
      hit = pickBestSyncedResult(results, { artist, track, durationSec });
    }

    if (hit?.syncedLyrics) {
      result = { lines: parseLrc(hit.syncedLyrics) };
    }
  } catch (err) {
    console.warn(`Lyrics lookup failed for "${artist} – ${track}": ${err.message}`);
  }

  cache.set(key, result);
  return result;
}

// Given the parsed lines and the track's current playback position, return
// ONLY the single line that should be showing right now (or null). This is
// the sole way the rest of the app ever touches lyric text — there is no
// function anywhere that returns the whole song at once.
export function currentLine(lines, positionMs) {
  if (!lines || !lines.length) return null;
  let current = null;
  for (const line of lines) {
    if (line.ms > positionMs) break;
    current = line;
  }
  return current?.text ?? null;
}

/** Test seam only. */
export function _clearCache() { cache.clear(); }
export function _cacheSize() { return cache.size; }
