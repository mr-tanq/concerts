// spotify-listening-provider.js
//
// The ONLY file in the app that knows Spotify's API response shape.
// Everything it hands upward is already a generic CurrentListeningState
// (see listening-state.js) — Mirror never touches raw Spotify JSON, and
// never needs to know Spotify happens to be polled every 5 seconds to get
// it. That polling detail lives entirely here, which is exactly what lets
// a future push-based provider (Android) hand Mirror the same shape
// through the same onState callback without imitating this loop at all.
//
// CurrentListeningState fields:
//   source, artist, track, album, artwork, isPlaying, durationMs,
//   positionMs, externalId, externalUrl, confidence, capturedAt,
//   controlsSupported
// A field is null whenever a source legitimately can't provide it —
// never a placeholder or guessed value.
//
// One deliberate addition beyond that list: primaryArtist. The existing
// lyrics lookup has always searched on the FIRST credited artist alone
// (Spotify's own artists[0].name), not the joined "A, B" display string —
// collapsing those into one field would silently change what gets
// searched for a multi-artist track, which the Phase 1A acceptance
// criteria explicitly rule out ("synced lyrics work exactly as before").
// It's real data Spotify already returns, not an invented value.

import { disconnectSpotify, getValidAccessToken } from "./spotify-auth.js";

export const SPOTIFY_SOURCE = "spotify";
const POLL_MS = 5000;

let pollTimer = null;
let activeCallbacks = null; // { onState, onError }

async function spotifyFetch(path, options = {}) {
  const token = await getValidAccessToken();
  if (!token) {
    const err = new Error("Not connected to Spotify.");
    err.code = "reauth-required";
    throw err;
  }
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    disconnectSpotify();
    const err = new Error("Spotify rejected the access token.");
    err.code = "reauth-required";
    throw err;
  }
  return res;
}

// Pure — Spotify's raw JSON (plus the measured round-trip time) in,
// either null ("nothing identifiable is playing") or a fully generic
// CurrentListeningState out. No caller needs to know Spotify's response
// shape ever again after this point.
export function normalizeSpotifyState(json, roundTripMs = 0) {
  if (!json?.item) return null;
  const item = json.item;
  return {
    source: SPOTIFY_SOURCE,
    artist: (item.artists || []).map((a) => a.name).join(", ") || null,
    primaryArtist: item.artists?.[0]?.name || null,
    track: item.name || null,
    album: item.album?.name ?? null,
    artwork: item.album?.images?.[0]?.url ?? null,
    isPlaying: !!json.is_playing,
    durationMs: item.duration_ms ?? null,
    // Spotify's progress_ms reflects where playback was WHEN THEIR SERVER
    // processed the request, not when we finish receiving the response.
    // On a slower connection that gap is exactly the "lyrics feel a beat
    // behind" sensation — correcting for it here means every consumer of
    // positionMs gets an already-compensated value, not just the lyric line.
    positionMs: json.progress_ms != null ? json.progress_ms + roundTripMs : null,
    externalId: item.id ?? null,
    externalUrl: item.external_urls?.spotify ?? null,
    // Spotify is a first-party, authoritative source about the user's own
    // account — not a fingerprint guess. Maximum confidence is the honest
    // value here, not an arbitrary one.
    confidence: 1,
    capturedAt: new Date().toISOString(),
    // Carried ON the state itself so Mirror can ask "does THIS state
    // support controls" rather than "is this Spotify" — the distinction
    // that keeps a future source from needing a hardcoded exception.
    controlsSupported: true,
  };
}

async function fetchSpotifyState() {
  const requestStartedAt = performance.now();
  const res = await spotifyFetch("/me/player/currently-playing");
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Spotify HTTP ${res.status}`);
  const json = await res.json();
  const roundTripMs = performance.now() - requestStartedAt;
  return normalizeSpotifyState(json, roundTripMs);
}

// Owns its own polling loop end to end — start/stop, visibility pausing,
// error propagation. Mirror only ever sees onState/onError fire; it has
// no idea this is a 5-second interval under the hood.
export function startSpotifyProvider({ onState, onError }) {
  stopSpotifyProvider();
  activeCallbacks = { onState, onError };

  const tick = async () => {
    if (document.hidden) return;
    try {
      const state = await fetchSpotifyState();
      activeCallbacks?.onState(state);
    } catch (err) {
      console.warn("Spotify provider poll failed:", err.message);
      activeCallbacks?.onError(err);
    }
  };
  tick();
  pollTimer = setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function onVisibilityChange() {
  if (!document.hidden && pollTimer && activeCallbacks) {
    // Fire immediately on return instead of waiting up to POLL_MS.
    const cb = activeCallbacks;
    stopSpotifyProvider();
    startSpotifyProvider(cb);
  }
}

export function stopSpotifyProvider() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  activeCallbacks = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

// ---------- Spotify-specific playback controls ----------
//
// Deliberately NOT part of the generic state flow — these only make
// sense for a source that actually supports remote control. Mirror gates
// access behind state.controlsSupported, never behind "is this Spotify".

export async function spotifyPlayPause(isCurrentlyPlaying) {
  return spotifyFetch(isCurrentlyPlaying ? "/me/player/pause" : "/me/player/play", { method: "PUT" });
}
export async function spotifyNext() {
  return spotifyFetch("/me/player/next", { method: "POST" });
}
export async function spotifyPrevious() {
  return spotifyFetch("/me/player/previous", { method: "POST" });
}