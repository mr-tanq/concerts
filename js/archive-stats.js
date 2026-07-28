// archive-stats.js
// Pure, dependency-free functions that turn the raw archive.json concerts
// array into every derived view the Archive tab needs. Keeping this in one
// module means Overview / Signature / Milestones / Timeline / Explore all
// read from exactly the same numbers — no drift between sections.

// A venue "family" groups rooms that belong to one building: De Helling and
// Pandora are both TivoliVredenburg. Counting raw room names instead would
// scatter 33 visits across three entries and hide the recurring room
// entirely, so every venue statistic goes through this.
export function venueKey(c) {
  return c.venueFamily || c.venue || null;
}

// Everyone who played, not just the billed headliner. Support and festival
// acts are the bulk of the lineup data, and dropping them made the
// most-seen-artist counts quietly wrong.
export function artistsOf(c) {
  if (Array.isArray(c.lineup) && c.lineup.length) return c.lineup;
  return [c.artist, ...(c.supportingArtists || [])].filter(Boolean);
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
    topArtist: countByList(concerts, artistsOf)[0] || null,
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
    mostSeenArtists: countByList(concerts, artistsOf).slice(0, topN),
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
    artist: countByList(concerts, artistsOf),
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
      return concerts.filter((c) => artistsOf(c).some((n) => n === value));
    case "city":
      return concerts.filter((c) => c.city === value);
    case "venue":
      return concerts.filter((c) => venueKey(c) === value);
    default:
      return concerts;
  }
}

export function buildArchiveView(concerts) {
  return {
    overview: getOverview(concerts),
    signature: getSignature(concerts),
    milestones: getMilestones(concerts),
    peakYear: getPeakYear(concerts),
    patterns: getPatterns(concerts),
    timeline: getTimeline(concerts),
    onThisDay: getOnThisDay(concerts),
    explore: getExploreOptions(concerts),
  };
}
