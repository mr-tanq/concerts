// android-listening-provider.js
//
// The Android side of the listening-source layer. Same interface as
// spotify-listening-provider.js -- startAndroidProvider({ onState, onError })
// / stopAndroidProvider() -- so Mirror could consume it identically. It is
// deliberately NOT wired into mirror.js in Phase 1B-2; source arbitration is
// Phase 1C.
//
// Reuses every hardening lesson already paid for on the Spotify provider:
// generation counter, session-local in-flight flag, AbortController,
// visibility pausing, no overlapping polls.

import { getReadSecret, POLL_MS, FRESHNESS_BUDGET_MS } from "./relay-config.js";
import { fetchRelayState, ageOnRelayMs, isFresh, compensatePosition, boundedNetworkAdjustmentMs } from "./relay-client.js";

const ANDROID_SOURCES = ["spotify_android", "youtube_android", "youtube_music_android", "android_media"];

let pollTimer = null;
let activeCallbacks = null;
let generation = 0;
let activeAbortController = null;

// Browser-MONOTONIC freshness deadline.
//
// This exists because received_at alone cannot detect staleness during total
// relay failure: if every GET fails, no new received_at ever arrives, so the
// last track would persist forever -- exactly the failure the TTL exists to
// prevent. performance.now() is used rather than Date.now() because it is
// monotonic and unaffected by system clock changes, matching the reasoning
// behind elapsedRealtime() on the Android side.
let lastFreshAtMonotonic = null;

// The currently active session's tick. Held at module scope purely so
// visibility handling can fire an immediate poll WITHOUT restarting the
// provider -- see onVisibilityChange for why that distinction matters.
let activeTick = null;

export function startAndroidProvider({ onState, onError }) {
  stopAndroidProvider();
  generation++;
  const myGeneration = generation;
  activeCallbacks = { onState, onError };
  lastFreshAtMonotonic = null;

  let pollInFlight = false; // session-local, never module-level

  const tick = async () => {
    if (document.hidden) return;
    if (pollInFlight) return;
    pollInFlight = true;
    const controller = new AbortController();
    activeAbortController = controller;

    const secret = getReadSecret();
    if (!secret) {
      pollInFlight = false;
      if (myGeneration === generation) {
        const err = new Error("No relay read secret configured.");
        err.code = "no-secret";
        activeCallbacks?.onError(err);
      }
      return;
    }

    try {
      const { payload, rttMs } = await fetchRelayState(secret, { signal: controller.signal });
      if (myGeneration !== generation) return;

      if (isFresh(payload)) {
        const relayAgeMs = ageOnRelayMs(payload);
        // Preserve the freshness budget already consumed BEFORE this read.
        // If the row is already 55s old, a successful GET must not grant it a
        // brand-new local 60s lifetime when the relay immediately disappears.
        // Add only the same bounded half-RTT estimate used for position, since
        // that is the small amount of additional age accrued in transit.
        const consumedAgeMs = relayAgeMs + boundedNetworkAdjustmentMs(rttMs);
        lastFreshAtMonotonic = performance.now() - consumedAgeMs;
        const raw = payload.present ? payload.state : null;
        const state = raw ? compensatePosition(raw, relayAgeMs, rttMs) : null;
        activeCallbacks?.onState(state);
      } else {
        // Relay reachable but its stored row has aged out.
        activeCallbacks?.onState(null);
      }
    } catch (err) {
      if (myGeneration !== generation) return;
      if (err.name === "AbortError") return;
      activeCallbacks?.onError(err);
      // Fall through to the expiry check below -- a failed poll must still
      // be able to expire a cached state.
    } finally {
      pollInFlight = false;
      if (activeAbortController === controller) activeAbortController = null;
    }

    if (myGeneration !== generation) return;
    // Evaluated on EVERY tick, including ones whose fetch threw. Once the
    // budget is exceeded, keep emitting null: continued failures must never
    // resurrect or indefinitely preserve the previous track.
    if (hasExpiredLocally()) activeCallbacks?.onState(null);
  };

  activeTick = tick;
  tick();
  pollTimer = setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

/** Exported for testing: has the monotonic freshness budget run out? */
export function hasExpiredLocally(nowMs = performance.now(), budgetMs = FRESHNESS_BUDGET_MS) {
  if (lastFreshAtMonotonic === null) return false; // nothing fresh yet to expire
  return nowMs - lastFreshAtMonotonic > budgetMs;
}

/** Exported for testing only. */
export function _setLastFreshAtMonotonic(value) { lastFreshAtMonotonic = value; }

function onVisibilityChange() {
  if (document.hidden || !pollTimer || !activeCallbacks) return;
  // Deliberately NOT stop+start. stopAndroidProvider() clears
  // lastFreshAtMonotonic, and doing that on a visibility round-trip
  // destroyed the local TTL history: after hiding the tab, waiting out the
  // budget, and returning to an unreachable relay, there was no longer an
  // anchor to expire FROM, so hasExpiredLocally() stayed false forever and
  // a dead track could render indefinitely -- defeating the exact guarantee
  // the local budget exists to provide.
  //
  // Returning to the tab only needs an immediate poll, not a new session,
  // so fire the existing tick and leave the freshness anchor intact.
  activeTick?.();
}

export function stopAndroidProvider() {
  generation++;
  activeTick = null;
  activeAbortController?.abort();
  activeAbortController = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  activeCallbacks = null;
  lastFreshAtMonotonic = null;
}

export function isAndroidSource(source) {
  return ANDROID_SOURCES.includes(source);
}
