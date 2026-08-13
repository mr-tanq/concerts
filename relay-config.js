// relay-config.js
//
// Public client configuration. Neither value is a secret: the project URL is
// an address, and the publishable/anon key is designed to ship in clients.
// Neither grants anything on its own -- the transport tables live in a
// `private` schema the anon role has no USAGE on, with RLS enabled and zero
// policies. The only reachable surface is two SECURITY DEFINER functions,
// each of which requires the separately-entered transport secret.
//
// Shipping these as ordinary config is what keeps manual setup to one
// pasted secret.

export const RELAY_URL = "https://lsnhmthhtjinyidnojiq.supabase.co";
export const RELAY_ANON_KEY = "sb_publishable_LZByzzlMw_FoZ2Qgw3idkw_Isey-exW";

// The read secret is NOT compiled in -- it's entered once and kept in
// localStorage, the same pattern the app already uses for the GitHub PAT
// and Spotify Client ID.
const READ_SECRET_KEY = "lm_relay_read_secret";

export function getReadSecret() {
  try { return localStorage.getItem(READ_SECRET_KEY); } catch { return null; }
}
export function saveReadSecret(secret) {
  localStorage.setItem(READ_SECRET_KEY, secret.trim());
}
export function clearReadSecret() {
  localStorage.removeItem(READ_SECRET_KEY);
}

// Freshness budget. 60s = 3 missed 20s heartbeats: two consecutive misses is
// a routine mobile-network event (tunnel, lift, handover) and must not blank
// Mirror; three sustained means something is genuinely wrong. Same reasoning
// as MAX_TOLERATED_MISSES in mirror.js.
export const FRESHNESS_BUDGET_MS = 60_000;

// Only the uncertain network-travel term is bounded. The relay-age term is
// authoritative because relay_now and received_at come from the same server
// clock, and is already bounded separately by FRESHNESS_BUDGET_MS.
export const MAX_RTT_ADJUSTMENT_MS = 5_000;

export const POLL_MS = 5000;
