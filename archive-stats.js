// archive-stats.js
// Pure, dependency-free functions that turn the raw archive.json concerts
// array into every derived view the Archive tab needs. Keeping this in one
// module means Overview / Signature / Milestones / Timeline / Explore all
// read from exactly the same numbers — no drift between sections.

export function sortByDateAsc(concerts) {
  return [...concerts].sort((a, b) => a.date.localeCompare(b.date));
}

export function countBy(concerts, keyFn) {
  const counts = new Map();
  for (const c of concerts) {
    const key = keyFn(c);
    if (key == null) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function getOverview(concerts) {
  const festivals = concerts.filter((c) => c.isFestival).length;
  const venues = new Set(concerts.map((c) => c.venue)).size;
  const cities = new Set(concerts.map((c) => c.city)).size;
  return {
    totalConcerts: concerts.length,
    festivals,
    venues,
    cities,
  };
}

export function getSignature(concerts) {
  const artists = countBy(concerts, (c) => c.artist);
  const venues = countBy(concerts, (c) => c.venue);
  const cities = countBy(concerts, (c) => c.city);
  return {
    topArtist: artists[0] || null,
    topVenue: venues[0] || null,
    topCity: cities[0] || null,
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
  const byYear = countBy(concerts, (c) => c.date.slice(0, 4));
  return byYear[0] || null; // { name: "2025", count: 24 }
}

export function getPatterns(concerts, topN = 5) {
  return {
    mostSeenArtists: countBy(concerts, (c) => c.artist).slice(0, topN),
    recurringRooms: countBy(concerts, (c) => c.venue).slice(0, topN),
    topCities: countBy(concerts, (c) => c.city).slice(0, topN),
  };
}

export function getTimeline(concerts) {
  // newest first, for the scrolling timeline view
  return [...concerts].sort((a, b) => b.date.localeCompare(a.date));
}

export function getOnThisDay(concerts, today = new Date()) {
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return concerts.filter((c) => {
    const [, cmm, cdd] = c.date.split("-");
    return cmm === mm && cdd === dd;
  });
}

export function filterConcerts(concerts, { year, artist, city, venue } = {}) {
  return concerts.filter((c) => {
    if (year && c.date.slice(0, 4) !== String(year)) return false;
    if (artist && c.artist !== artist) return false;
    if (city && c.city !== city) return false;
    if (venue && c.venue !== venue) return false;
    return true;
  });
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
  };
}
