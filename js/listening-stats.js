// listening-state.js
//
// The generic shape every listening source normalizes into before Mirror
// ever sees it. Kept as its own small file — not folded into mirror.js —
// because Phase 1C's source arbitration (Spotify vs. Android reporting at
// the same time) will need this exact identity logic to compare two
// states against each other, not just to render one.

function normalizeText(s) {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

// A source's positionMs/durationMs is only trustworthy when it's an
// actual finite number that isn't negative — NaN, +/-Infinity, negative
// sentinel values, null, and undefined all mean "no reliable number was
// provided," never "zero." Zero itself (track just started) is valid.
// Centralized here rather than re-implemented at each call site, since
// Phase 1C's arbitration will need the identical rule when comparing
// positions across providers.
export function isValidPlaybackNumber(ms) {
  return Number.isFinite(ms) && ms >= 0;
}

// Stable identity for a CurrentListeningState: prefer the source's own
// external ID when it has one (exact, unambiguous — a Spotify track ID
// today), fall back to a normalized artist+title pair when it doesn't
// (a source with no stable per-track ID at all).
export function identityKeyFor(state) {
  if (!state) return null;
  const base = state.externalId
    ? state.externalId
    : `${normalizeText(state.artist)}|${normalizeText(state.track)}`;
  return `${state.source}:${base}`;
}