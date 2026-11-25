// artwork-lookup.js
//
// Cover art for Mirror when the source doesn't provide any. The YouTube
// Android app only hands the companion a bitmap (no URL a browser can load),
// so YouTube plays arrive with artwork: null. Mirror then looks the cover up
// from artist + title:
//
//   1. iTunes Search (public, no key)           — best covers, broad catalogue
//   2. MusicBrainz → Cover Art Archive (public)  — fallback, good for indie
//
// Results — including "nothing found" — are remembered per song, in memory
// and in this browser's storage, so a song is looked up once, not on every
// 5-second poll. Every network or parse failure simply resolves to null:
// artwork is decoration and must never break Mirror.

const STORE_KEY = "lm_artwork_cache_v1";
const MAX_ENTRIES = 300;
const MISS_TTL_MS = 3 * 24 * 60 * 60 * 1000; // retry "not found" after 3 days
const TIMEOUT_MS = 6000;

const memory = new Map();
const inflight = new Map();
let loaded = false;

export function normalizeName(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// YouTube titles and channel names carry noise that search engines don't.
export function cleanForSearch({ artist, track }) {
  const a = String(artist || "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/vevo$/i, "")
    .replace(/\s*\(official\)$/i, "")
    .trim();
  let t = String(track || "")
    .replace(/\s*[([](?:official|lyric|lyrics|audio|video|visuali[sz]er|music video|hd|4k|live)[^)\]]*[)\]]/gi, "")
    .replace(/\s*\|.*$/, "")
    .trim();
  // "Artist - Title" uploaded under some other channel name.
  const dash = t.split(/\s+[-–—]\s+/);
  if (dash.length === 2 && normalizeName(dash[0]) === normalizeName(a)) t = dash[1];
  return { artist: a, track: t };
}

function sameArtist(a, b) {
  const x = normalizeName(a), y = normalizeName(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    for (const [k, v] of Object.entries(saved)) memory.set(k, v);
  } catch {}
}

function save() {
  try {
    const entries = [...memory.entries()].slice(-MAX_ENTRIES);
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

async function getJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function pickItunesArtwork(json, artist, track) {
  const results = (json?.results || []).filter((r) => r?.artworkUrl100 && sameArtist(r.artistName, artist));
  if (!results.length) return null;
  const want = normalizeName(track);
  const best = results.find((r) => normalizeName(r.trackName) === want)
    || results.find((r) => want && normalizeName(r.trackName).startsWith(want))
    || results[0];
  return best.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x600bb.");
}

async function fromItunes(artist, track) {
  const term = encodeURIComponent(`${artist} ${track}`.trim());
  const json = await getJSON(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=10`);
  return pickItunesArtwork(json, artist, track);
}

async function fromMusicBrainz(artist, track) {
  const q = `recording:"${track.replace(/"/g, "")}" AND artist:"${artist.replace(/"/g, "")}"`;
  const json = await getJSON(`https://musicbrainz.org/ws/2/recording/?fmt=json&limit=5&query=${encodeURIComponent(q)}`);
  const releases = (json?.recordings || [])
    .filter((r) => (r["artist-credit"] || []).some((c) => sameArtist(c?.name || c?.artist?.name, artist)))
    .flatMap((r) => r.releases || []);
  for (const release of releases.slice(0, 3)) {
    const art = await getJSON(`https://coverartarchive.org/release/${release.id}`);
    const front = (art?.images || []).find((img) => img.front) || art?.images?.[0];
    const url = front?.thumbnails?.["500"] || front?.thumbnails?.large || front?.image;
    if (url) return url.replace(/^http:/, "https:");
  }
  return null;
}

/**
 * Cover art URL for a song, or null. Never throws.
 */
export async function findArtwork({ artist, track }) {
  const clean = cleanForSearch({ artist, track });
  if (!clean.artist || !clean.track) return null;
  const key = `${normalizeName(clean.artist)}|${normalizeName(clean.track)}`;
  load();
  const known = memory.get(key);
  if (known && (known.url || Date.now() - known.at < MISS_TTL_MS)) return known.url || null;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    let url = null;
    try {
      url = await fromItunes(clean.artist, clean.track)
        || await fromMusicBrainz(clean.artist, clean.track);
    } catch { url = null; }
    memory.delete(key);
    memory.set(key, { url, at: Date.now() });
    save();
    return url;
  })();
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}
