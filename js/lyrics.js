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

const cache = new Map(); // "artist::track" -> { lines: [{ms, text}] } | { lines: null } (not found)

function cacheKey(artist, track) {
  return `${artist.toLowerCase().trim()}::${track.toLowerCase().trim()}`;
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
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (res.status === 404) return null; // "not found" is a normal answer here
    if (!res.ok) throw new Error(`lrclib HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Fetches once per (artist, track) pair per session and caches the result
// — including negative results, so a song lrclib doesn't have isn't
// re-requested every 5 seconds while it keeps playing.
export async function getSyncedLyrics({ artist, track, album, durationSec }) {
  const key = cacheKey(artist, track);
  if (cache.has(key)) return cache.get(key);

  let result = { lines: null };
  try {
    const params = new URLSearchParams({ track_name: track, artist_name: artist });
    if (album) params.set("album_name", album);
    if (durationSec) params.set("duration", String(Math.round(durationSec)));

    let hit = await fetchJson(`https://lrclib.net/api/get?${params}`);

    // The exact-match endpoint is strict (album/duration must line up
    // closely); fall back to search, which is looser, before giving up.
    if (!hit?.syncedLyrics) {
      const searchParams = new URLSearchParams({ track_name: track, artist_name: artist });
      const results = await fetchJson(`https://lrclib.net/api/search?${searchParams}`);
      hit = Array.isArray(results) ? results.find((r) => r.syncedLyrics) : null;
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
