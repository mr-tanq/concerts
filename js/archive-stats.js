// archive-stats.js
// Pure, dependency-free functions that turn the raw archive.json concerts
// array into every derived view the Archive tab needs. Keeping this in one
// module means Overview / Signature / Milestones / Timeline / Explore all
// read from exactly the same numbers — no drift between sections.

// A venue "family" groups rooms that belong to one building: De Helling and
// Pandora are both TivoliVredenburg. Counting raw room names instead would
// scatter 33 visits across three entries and hide the recurring room
// entirely, so every venue statistic goes through this.
// Exact aliases for confirmed venues; never merge by partial name.
const VENUE_NAMES = [
  ["dB’s", ["dB’s", "dB's"]],
  ["Technopolis", ["Technopolis", "Technopolis City of Athens"]],
  ["Poppodium 013", ["Poppodium 013", "013", "013 Poppodium"]],
];
function venueNameKey(name) {
  return String(name || "").normalize("NFKD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "").replace(/['’‘ʼ]/g, "'")
    .replace(/\s+/g, " ").trim();
}
function canonicalVenueName(name) {
  if (typeof name !== "string") return name;
  const key = venueNameKey(name);
  const group = VENUE_NAMES.find(([, aliases]) => aliases.some(alias => venueNameKey(alias) === key));
  return group ? group[0] : name;
}
export function venueKey(c) {
  return canonicalVenueName(c.venueFamily || c.venue || null);
}
export function venueSearchNames(name) {
  const canonical = canonicalVenueName(name);
  const group = VENUE_NAMES.find(([display]) => display === canonical);
  return group ? group[1] : [name];
}

// Everyone who played, not just the billed headliner. Support and festival
// acts are the bulk of the lineup data, and dropping them made the
// most-seen-artist counts quietly wrong.
export function artistsOf(c) {
  if (Array.isArray(c.lineup) && c.lineup.length) return c.lineup;
  return [c.artist, ...(c.supportingArtists || [])].filter(Boolean);
}

// Who was actually watched, as distinct from who was on the bill.
// c.seenArtists is only ever set once the person curates a concert through
// the "who did you actually see" picker — before that, every name on the
// bill is assumed seen (the app's original, unqualified behavior), so this
// stays backward compatible with every concert already in the archive.
// Uses Array.isArray rather than a length check so an explicitly-saved
// empty list ("I saw none of the support") is honored rather than treated
// as "never curated".
export function actuallySeenArtistsOf(c) {
  if (Array.isArray(c.seenArtists)) return c.seenArtists;
  return artistsOf(c);
}

export function sortByDateAsc(concerts) {
  return [...concerts].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export function countBy(concerts, keyFn) {
  const counts = new Map();
  for (const c of concerts) {
    const key = keyFn(c);
    if (key == null || key === "") continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Counts across a list-valued field (the lineup), so one concert can add to
// several artists.
export function countByList(concerts, listFn) {
  const counts = new Map();
  for (const c of concerts) {
    for (const value of new Set(listFn(c) || [])) {
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Match the same artist despite case, accents or extra spaces. Keep
// punctuation meaningful: similarly named bands must remain separate.
export function artistKey(name) {
  return String(name || "").toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

// Count an artist once per concert, preserving an existing spelling for
// display. The most common spelling wins; ties are stable across sorting.
export function countArtists(concerts) {
  const groups = new Map();
  for (const c of concerts) {
    const night = new Map();
    for (const name of actuallySeenArtistsOf(c)) {
      const key = artistKey(name);
      if (!key) continue;
      if (!night.has(key)) night.set(key, new Set());
      night.get(key).add(String(name).trim().replace(/\s+/g, " "));
    }
    for (const [key, names] of night) {
      if (!groups.has(key)) groups.set(key, { count: 0, names: new Map() });
      const group = groups.get(key);
      group.count++;
      for (const name of names) group.names.set(name, (group.names.get(name) || 0) + 1);
    }
  }
  return [...groups.values()].map(({ count, names }) => ({
    name: [...names].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0],
    count,
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function getOverview(concerts) {
  return {
    totalConcerts: concerts.length,
    festivals: concerts.filter((c) => c.isFestival).length,
    venues: new Set(concerts.map(venueKey).filter(Boolean)).size,
    cities: new Set(concerts.map((c) => c.city).filter(Boolean)).size,
  };
}

export function getSignature(concerts) {
  return {
    topArtist: countArtists(concerts)[0] || null,
    topVenue: countBy(concerts, venueKey)[0] || null,
    topCity: countBy(concerts, (c) => c.city)[0] || null,
  };
}

export function getMilestones(concerts) {
  const sorted = sortByDateAsc(concerts);
  return {
    first: sorted[0] || null,
    latest: sorted[sorted.length - 1] || null,
  };
}

export function getPeakYear(concerts) {
  return countBy(concerts, (c) => String(c.date || "").slice(0, 4))[0] || null;
}

export function getPatterns(concerts, topN = 5) {
  return {
    mostSeenArtists: countArtists(concerts).slice(0, topN),
    recurringRooms: countBy(concerts, venueKey).slice(0, topN),
    topCities: countBy(concerts, (c) => c.city).slice(0, topN),
  };
}

export function getTimeline(concerts) {
  return [...concerts].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function getOnThisDay(concerts, today = new Date()) {
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const year = today.getFullYear();
  return concerts
    .filter((c) => {
      const [cy, cmm, cdd] = String(c.date || "").split("-");
      return cmm === mm && cdd === dd && Number(cy) < year;
    })
    .map((c) => ({ ...c, yearsAgo: year - Number(String(c.date).slice(0, 4)) }))
    .sort((a, b) => a.yearsAgo - b.yearsAgo);
}

// Options for the Explore filters, each with its own counts so the pills
// can be ordered by how much of the archive they actually represent.
export function getExploreOptions(concerts) {
  return {
    year: countBy(concerts, (c) => String(c.date || "").slice(0, 4)),
    artist: countArtists(concerts),
    city: countBy(concerts, (c) => c.city),
    venue: countBy(concerts, venueKey),
  };
}

export function filterConcerts(concerts, { mode, value } = {}) {
  if (!mode || mode === "all" || !value) return concerts;
  switch (mode) {
    case "year":
      return concerts.filter((c) => String(c.date || "").slice(0, 4) === String(value));
    case "artist":
      return concerts.filter((c) => actuallySeenArtistsOf(c).some((n) => artistKey(n) === artistKey(value)));
    case "city":
      return concerts.filter((c) => c.city === value);
    case "venue":
      return concerts.filter((c) => venueKey(c) === venueKey({ venue: value }));
    default:
      return concerts;
  }
}

export function buildArchiveView(concerts, today = new Date()) {
  return {
    overview: getOverview(concerts),
    signature: getSignature(concerts),
    milestones: getMilestones(concerts),
    peakYear: getPeakYear(concerts),
    patterns: getPatterns(concerts),
    timeline: getTimeline(concerts),
    onThisDay: getOnThisDay(concerts, today),
    explore: getExploreOptions(concerts),
  };
}
