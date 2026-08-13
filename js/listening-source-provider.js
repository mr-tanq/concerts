// listening-source-provider.js
//
// Phase 1C. Mirror talks only to this; it owns both child providers and
// decides which single CurrentListeningState Mirror sees.
//
// Same interface shape as the child providers it wraps
// (start...({ onState, onError }) / stop...), so mirror.js swaps one import
// for another rather than learning a new pattern.
//
// Deliberately does NOT merge metadata between sources and never invents
// confidence or IDs: exactly one state is selected and forwarded intact.

import { startSpotifyProvider, stopSpotifyProvider } from "./spotify-listening-provider.js";
import { startAndroidProvider, stopAndroidProvider } from "./android-listening-provider.js";

/**
 * Spotify's own poll runs every 5s. Three missed cycles is the point at
 * which a cached "isPlaying: true" stops being evidence of anything and
 * starts being a stale claim that would block Android forever.
 *
 * Chosen to tolerate a single transient HTTP/network blip without flipping
 * source (one failed poll costs 5s, well inside the budget), while still
 * releasing the lock promptly when Spotify genuinely dies.
 *
 * Android's own 60s relay TTL is separate, lives in
 * android-listening-provider.js, and is deliberately untouched here.
 */
export const SPOTIFY_STALE_MS = 15_000;

/**
 * Minimum spacing between successive `null` emissions.
 *
 * Mirror's existing miss-tolerance (MAX_TOLERATED_MISSES) counts EMISSIONS,
 * not elapsed time — it exists because Spotify reports "nothing" for one
 * poll straight after a pause. With two providers each reporting null every
 * 5s, forwarding every null would double the emission rate and halve that
 * protection window, making a paused track briefly vanish. Spacing nulls to
 * roughly one poll cycle keeps Mirror's behaviour exactly as it is today,
 * however many providers are enabled.
 */
export const NULL_EMIT_MIN_INTERVAL_MS = 4_500;

const ANDROID_SPOTIFY_SOURCE = "spotify_android";

// Indirection so tests can drive the coordinator with controllable child
// providers. Production always uses the real ones; ES modules are immutable
// bindings, so a seam here is the only way to exercise the emission and
// arbitration logic without real network polling.
let children = {
  startSpotify: startSpotifyProvider,
  stopSpotify: stopSpotifyProvider,
  startAndroid: startAndroidProvider,
  stopAndroid: stopAndroidProvider,
};

let callbacks = null;
let enabled = { spotify: false, android: false };

let spotifyState = null;
let androidState = null;

let lastSpotifySuccessAtMonotonic = null;
let spotifyInvalidated = false;      // set by reauth-required
let spotifyResponded = false;
let androidResponded = false;
let androidLastWasError = false;

let lastEmittedProvider = undefined;  // 'spotify' | 'android' | null
let lastNullEmitAtMonotonic = null;

function now() { return performance.now(); }

/** Spotify's cached state, or null when it can no longer be trusted. */
function usableSpotifyState() {
  if (!enabled.spotify) return null;
  if (spotifyInvalidated) return null;
  if (lastSpotifySuccessAtMonotonic === null) return null;
  if (now() - lastSpotifySuccessAtMonotonic > SPOTIFY_STALE_MS) return null;
  return spotifyState;
}

function usableAndroidState() {
  if (!enabled.android) return null;
  return androidState;
}

/**
 * The priority ladder. Returns { provider, state } — provider is null when
 * nothing qualifies.
 *
 * Spotify Web is deliberately primary: it has richer metadata, real IDs, and
 * is the only source that supports controls.
 */
export function arbitrate(spotify, android) {
  // 1. Spotify Web actively playing.
  if (spotify && spotify.isPlaying === true) return { provider: "spotify", state: spotify };

  // 2. Any Android source actively playing (covers the "Spotify paused,
  //    YouTube playing" case, and the Spotify-Web-unavailable fallback).
  if (android && android.isPlaying === true) return { provider: "android", state: android };

  // 3. Paused NON-Spotify Android: a paused YouTube is more likely to be
  //    what you're actually listening to than a stale paused Spotify.
  if (android && android.isPlaying === false && android.source !== ANDROID_SPOTIFY_SOURCE) {
    return { provider: "android", state: android };
  }

  // 4. Paused Spotify Web — preferred over paused spotify_android because
  //    it's the same underlying playback reported by the richer source.
  if (spotify && spotify.isPlaying === false) return { provider: "spotify", state: spotify };

  // 5. Paused spotify_android, last resort.
  if (android && android.isPlaying === false) return { provider: "android", state: android };

  return { provider: null, state: null };
}

/** True once every ENABLED provider has produced a first result or error. */
function allEnabledHaveAnswered() {
  if (enabled.spotify && !spotifyResponded) return false;
  if (enabled.android && !androidResponded) return false;
  return true;
}

/**
 * Android counts as a working alternative path when it's enabled, has
 * answered, and its last answer wasn't an error. "Nothing playing" still
 * counts as working — the transport is alive, there just isn't a track.
 */
function androidPathUsable() {
  return enabled.android && androidResponded && !androidLastWasError;
}

/**
 * @param fromProvider which child triggered this
 * @param cause "state" for a real onState, "error" for an onError.
 *
 * An ERROR IS NOT A STATE UPDATE. Re-emitting the cached state on an error
 * would re-anchor Mirror to an old positionMs (visibly rewinding or freezing
 * progress and lyrics), and would also clear the error status instantly,
 * since handleListeningState() treats every onState as recovery. So an error
 * only emits when it genuinely changes which provider is selected -- i.e.
 * when there is a real fallback state to show instead.
 */
function evaluate(fromProvider, cause = "state") {
  if (!callbacks) return;

  const { provider, state } = arbitrate(usableSpotifyState(), usableAndroidState());

  if (cause === "error" && provider === lastEmittedProvider) return;

  if (provider === null) {
    // Startup guard: one provider answering null before the other has said
    // anything must not flash "Nothing playing" over a source that's about
    // to report a live track.
    if (!allEnabledHaveAnswered()) return;

    const t = now();
    if (lastNullEmitAtMonotonic !== null && t - lastNullEmitAtMonotonic < NULL_EMIT_MIN_INTERVAL_MS) {
      return;
    }
    lastNullEmitAtMonotonic = t;
    lastEmittedProvider = null;
    callbacks.onState(null);
    return;
  }

  lastNullEmitAtMonotonic = null;

  const selectionChanged = provider !== lastEmittedProvider;
  // A callback from the NON-selected provider must not re-render Mirror:
  // without this, Android polling every 5s would rebuild the Spotify view
  // continuously for no reason.
  if (!selectionChanged && fromProvider !== provider) return;

  lastEmittedProvider = provider;
  callbacks.onState(state);
}

export function startListeningProvider({ enableSpotify, enableAndroid, onState, onError }) {
  stopListeningProvider();
  callbacks = { onState, onError };
  enabled = { spotify: !!enableSpotify, android: !!enableAndroid };

  if (enabled.spotify) {
    children.startSpotify({
      onState: (state) => {
        spotifyState = state;
        // A successful poll -- including one reporting "nothing playing" --
        // is what proves Spotify is alive, so it refreshes the staleness
        // anchor either way.
        lastSpotifySuccessAtMonotonic = now();
        spotifyInvalidated = false;
        spotifyResponded = true;
        evaluate("spotify");
      },
      onError: (err) => {
        spotifyResponded = true;
        if (err.code === "reauth-required") {
          // Auth is gone; the cached state can't come back on its own.
          spotifyInvalidated = true;
          spotifyState = null;
        }
        // Deliberately does NOT touch lastSpotifySuccessAtMonotonic: a single
        // transient error must not flip source, it just lets the clock run
        // toward SPOTIFY_STALE_MS.
        //
        // Evaluate BEFORE surfacing: a reauth-required can switch to an
        // already-valid Android state first, after which this Spotify error
        // is by definition non-selected and must not tear Mirror down.
        evaluate("spotify", "error");
        handleChildError("spotify", err);
      },
    });
  }

  if (enabled.android) {
    children.startAndroid({
      onState: (state) => {
        androidState = state;
        androidResponded = true;
        androidLastWasError = false;
        evaluate("android");
      },
      onError: (err) => {
        androidResponded = true;
        androidLastWasError = true;
        evaluate("android", "error");
        handleChildError("android", err);
      },
    });
  }
}

function handleChildError(fromProvider, err) {
  if (!callbacks) return;

  // Spotify losing auth while Android works must NOT tear Mirror down into
  // the Spotify setup screen -- Mirror carries on via Android. The old
  // reconnect behaviour is preserved only when Android can't cover for it.
  if (fromProvider === "spotify" && err.code === "reauth-required" && androidPathUsable()) {
    return;
  }

  // A failing provider that isn't the selected one shouldn't put a red error
  // over a healthy source.
  if (lastEmittedProvider !== null && lastEmittedProvider !== undefined && fromProvider !== lastEmittedProvider) {
    return;
  }

  callbacks.onError(err);
}

export function stopListeningProvider() {
  children.stopSpotify();
  children.stopAndroid();
  callbacks = null;
  enabled = { spotify: false, android: false };
  spotifyState = null;
  androidState = null;
  lastSpotifySuccessAtMonotonic = null;
  spotifyInvalidated = false;
  spotifyResponded = false;
  androidResponded = false;
  androidLastWasError = false;
  lastEmittedProvider = undefined;
  lastNullEmitAtMonotonic = null;
}

// ---- test seams (not used by production code) ----
export function _state() {
  return {
    spotifyState, androidState, lastEmittedProvider,
    spotifyInvalidated, lastSpotifySuccessAtMonotonic,
    spotifyResponded, androidResponded, androidLastWasError,
  };
}
export function _setSpotifySuccessAt(v) { lastSpotifySuccessAtMonotonic = v; }
export function _setChildren(overrides) {
  children = {
    startSpotify: startSpotifyProvider, stopSpotify: stopSpotifyProvider,
    startAndroid: startAndroidProvider, stopAndroid: stopAndroidProvider,
    ...overrides,
  };
}
