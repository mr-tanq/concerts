// relay-client.js
//
// One fetch against public.read_playback, plus the two pure decisions that
// depend on its response: is this state still fresh, and how far has playback
// advanced since the relay stored it.
//
// Both decision functions are exported and pure specifically so they can be
// tested without a network or a browser.

import { RELAY_URL, RELAY_ANON_KEY, FRESHNESS_BUDGET_MS, MAX_RTT_ADJUSTMENT_MS } from "./relay-config.js";

export async function fetchRelayState(readSecret, { signal } = {}) {
  const startedAt = performance.now();
  const res = await fetch(`${RELAY_URL}/rest/v1/rpc/read_playback`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      apikey: RELAY_ANON_KEY,
      Authorization: `Bearer ${RELAY_ANON_KEY}`,
    },
    body: JSON.stringify({ p_secret: readSecret }),
  });
  if (!res.ok) throw new Error(`Relay HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.ok) {
    const err = new Error("Relay rejected the read secret.");
    err.code = "invalid-secret";
    throw err;
  }
  return { payload: json, rttMs: performance.now() - startedAt };
}

// Age computed entirely on the RELAY's clock: relay_now and received_at both
// come from the same source, so this term carries no cross-machine skew. That
// property is the whole reason read_playback returns relay_now at all.
export function ageOnRelayMs(payload) {
  if (!payload?.received_at || !payload?.relay_now) return null;
  const received = Date.parse(payload.received_at);
  const now = Date.parse(payload.relay_now);
  if (!Number.isFinite(received) || !Number.isFinite(now)) return null;
  return now - received;
}

export function isFresh(payload, budgetMs = FRESHNESS_BUDGET_MS) {
  const age = ageOnRelayMs(payload);
  if (age === null) return false;
  return age >= 0 && age <= budgetMs;
}

// Browser-side travel time is the only uncertain part of position correction.
// Clamp that small uncertainty, NOT the relay age: relay_now and received_at
// are from one server clock and are trustworthy all the way up to the same
// freshness budget that decides whether the row is usable at all.
export function boundedNetworkAdjustmentMs(rttMs, maxRttAdjustmentMs = MAX_RTT_ADJUSTMENT_MS) {
  if (!Number.isFinite(rttMs) || rttMs <= 0) return 0;
  return Math.min(rttMs / 2, maxRttAdjustmentMs);
}

// Advance the transported position to "now", using the full skew-free relay
// age plus a bounded half-RTT estimate for the response's network travel.
//
// Rules, all deliberate:
//   - playing only: a paused position doesn't move
//   - null stays null: never invent a number the source didn't provide
//   - relay age must itself still be within the freshness budget
//   - only the uncertain RTT term is clamped
//   - final position is clamped to duration when duration is known
export function compensatePosition(
  state,
  ageMs,
  rttMs,
  freshnessBudgetMs = FRESHNESS_BUDGET_MS,
  maxRttAdjustmentMs = MAX_RTT_ADJUSTMENT_MS,
) {
  if (!state) return state;
  if (state.isPlaying !== true) return state;
  if (typeof state.positionMs !== "number" || !Number.isFinite(state.positionMs) || state.positionMs < 0) {
    return state;
  }
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > freshnessBudgetMs) return state;

  const compensation = ageMs + boundedNetworkAdjustmentMs(rttMs, maxRttAdjustmentMs);

  let advanced = state.positionMs + compensation;
  const duration = state.durationMs;
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0 && advanced > duration) {
    advanced = duration;
  }
  return { ...state, positionMs: Math.round(advanced) };
}
