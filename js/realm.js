// realm.js
//
// CONSTELLATION ATLAS — pass two: an actual (if hand-drawn, not surveyed)
// map, not a bubble chart.
//
// This app has no access to real coastline/border geometry, so rather than
// fake precision, the landmasses below are a deliberately simplified,
// hand-plotted impression — an atlas remembered, not measured. Rendered at
// 2–6% opacity above black, it only needs to be recognizable, not accurate
// to the meter. Your musical countries are what actually gets to be bright.
//
// "Importance" is carried by an atmosphere (a soft glow around the star,
// not a bigger circle) plus, for genuinely dense countries, a small
// scatter of satellite points suggesting a cluster of names rather than
// one number. Labels are selective: only countries that earn one at rest
// get one, positioned by a small collision-avoidance pass so nothing in
// the Netherlands/Belgium/Luxembourg tangle overlaps — anything displaced
// gets a thin leader line back to its star. Everything else surfaces on tap.
//
// Tapping a country no longer opens a list. It opens a journey: the
// cities where you actually encountered these artists, each one a stop,
// each stop naming who arrived there — origin → journey → encounter.

import { actuallySeenArtistsOf } from "./archive-stats.js";

let renderDeps = null; // { el, esc } injected from app.js
let archiveConcertsRef = []; // for the journey composition inside focus mode

export function initRealm(deps, concerts) {
  renderDeps = deps;
  archiveConcertsRef = concerts || [];
}

// Approximate centroids (lat, lon) — precision to a degree or two is
// intentional. Stars, not surveys.
const CENTROIDS = {
  AD: [42.5, 1.6], AE: [24.0, 54.0], AF: [33.9, 67.7], AL: [41.0, 20.0], AM: [40.1, 45.0],
  AR: [-38.4, -63.6], AT: [47.6, 14.6], AU: [-25.3, 133.8], BA: [43.9, 17.7], BE: [50.6, 4.5],
  BG: [42.7, 25.3], BR: [-10.3, -53.2], CA: [56.1, -106.3], CH: [46.8, 8.2], CL: [-35.7, -71.5],
  CN: [35.9, 104.2], CO: [4.6, -74.3], CU: [21.5, -79.5], CY: [35.1, 33.4], CZ: [49.8, 15.5],
  DE: [51.2, 10.5], DK: [56.3, 9.5], DZ: [28.0, 1.7], EC: [-1.8, -78.2], EE: [58.6, 25.0],
  EG: [26.8, 30.8], ES: [40.5, -3.7], ET: [9.1, 40.5], FI: [61.9, 25.7], FR: [46.6, 2.2],
  GB: [54.0, -2.0], GE: [42.3, 43.4], GH: [7.9, -1.0], GR: [39.1, 21.8], GT: [15.8, -90.2],
  HK: [22.3, 114.2], HR: [45.1, 15.2], HU: [47.2, 19.5], ID: [-0.8, 113.9], IE: [53.4, -8.2],
  IL: [31.0, 34.8], IN: [20.6, 79.0], IQ: [33.2, 43.7], IR: [32.4, 53.7], IS: [64.9, -19.0],
  IT: [41.9, 12.6], JM: [18.1, -77.3], JO: [30.6, 36.2], JP: [36.2, 138.3], KE: [-0.0, 37.9],
  KH: [12.6, 104.9], KR: [35.9, 127.8], KW: [29.3, 47.5], KZ: [48.0, 66.9], LB: [33.9, 35.9],
  LT: [55.2, 23.9], LU: [49.8, 6.1], LV: [56.9, 24.6], LY: [26.3, 17.2], MA: [31.8, -7.1],
  MC: [43.7, 7.4], MD: [47.4, 28.4], ME: [42.7, 19.4], MK: [41.6, 21.7], MN: [46.9, 103.8],
  MT: [35.9, 14.4], MX: [23.6, -102.6], MY: [4.2, 101.9], NG: [9.1, 8.7], NI: [12.9, -85.2],
  NL: [52.1, 5.3], NO: [60.5, 8.5], NP: [28.4, 84.1], NZ: [-40.9, 174.9], PA: [8.5, -80.8],
  PE: [-9.2, -75.0], PH: [12.9, 121.8], PK: [30.4, 69.3], PL: [51.9, 19.1], PR: [18.2, -66.6],
  PT: [39.4, -8.2], PY: [-23.4, -58.4], QA: [25.4, 51.2], RO: [45.9, 25.0], RS: [44.0, 21.0],
  RU: [61.5, 105.3], SA: [23.9, 45.1], SE: [60.1, 18.6], SG: [1.35, 103.8], SI: [46.1, 14.8],
  SK: [48.7, 19.7], SN: [14.5, -14.5], SV: [13.8, -88.9], SY: [34.8, 38.9], TH: [15.9, 100.9],
  TN: [33.9, 9.5], TR: [38.9, 35.2], TW: [23.7, 121.0], UA: [48.4, 31.2], UG: [1.4, 32.3],
  US: [39.8, -98.6], UY: [-32.5, -55.8], VE: [6.4, -66.6], VN: [14.1, 108.3], XK: [42.6, 20.9],
  ZA: [-30.6, 22.9], ZM: [-13.1, 27.8], ZW: [-19.0, 29.2],
};

// Home — used only to compute the "one came all the way from…" narrative
// fact via real distance, not a guess.
const HOME = { lat: 52.03, lon: 5.09 }; // Nieuwegein, NL

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeKeyLocal(name) {
  return (name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function project(lat, lon, width, height) {
  const x = ((lon + 180) / 360) * width;
  const y = ((90 - lat) / 180) * height;
  return [x, y];
}

const EUROPE_BOUNDS = { latMin: 29, latMax: 71, lonMin: -25, lonMax: 42 };

function projectInBounds(lat, lon, bounds, width, height) {
  const x = ((lon - bounds.lonMin) / (bounds.lonMax - bounds.lonMin)) * width;
  const y = ((bounds.latMax - lat) / (bounds.latMax - bounds.latMin)) * height;
  return [x, y];
}

// ---------- the hand-drawn atlas ----------
//
// Not survey data. A deliberately simplified impression of each landmass —
// enough points to be recognizable at a glance, at the low opacity this
// renders at, and nothing more. The same shapes are projected through
// BOTH the world and Europe views, so the coastline in the overview and
// the coastline in the close-up are always the same atlas, just zoomed.

const LANDMASSES = [
  // British Isles
  [[50.0,-5.7],[51.4,-2.6],[51.3,0.5],[52.5,1.7],[54.5,-0.5],[56.5,-2.5],[57.5,-2.0],
   [58.6,-3.0],[58.2,-5.5],[56.0,-5.5],[52.3,-4.7],[50.0,-5.0]],
  [[51.5,-9.5],[52.5,-6.5],[53.5,-6.0],[55.2,-6.5],[55.0,-8.2],[53.0,-9.8],[51.8,-10.2],[51.5,-9.5]],
  // Iberia
  [[43.4,-8.4],[43.5,-1.8],[42.5,3.2],[38.3,0.2],[36.0,-5.6],[37.2,-7.4],[38.7,-9.4],[41.7,-8.8],[43.4,-8.4]],
  // France / Benelux / Germany / Central Europe (one soft mainland mass)
  [[48.4,-4.5],[45.5,-1.2],[43.0,1.5],[43.3,5.0],[44.0,7.5],[46.0,8.0],[47.5,10.5],[50.5,15.0],
   [54.0,14.5],[57.7,10.5],[55.5,8.5],[53.2,5.5],[51.2,2.9],[48.4,-4.5]],
  // Scandinavia
  [[58.0,8.0],[59.9,10.7],[60.0,18.5],[63.5,19.0],[66.0,21.0],[69.0,20.0],[71.0,25.8],
   [69.5,17.0],[65.0,12.0],[62.0,6.0],[59.0,5.5],[58.0,8.0]],
  // Italy
  [[45.8,9.0],[45.4,13.4],[41.9,15.9],[40.4,17.9],[38.2,15.9],[38.1,13.4],[40.6,14.3],[43.8,10.3],[45.8,9.0]],
  // Balkans / Greece
  [[45.5,13.7],[44.0,15.5],[42.5,18.5],[39.5,20.0],[37.0,22.0],[38.0,24.0],[40.5,23.0],
   [41.5,26.0],[44.5,21.0],[45.5,13.7]],
  // Iceland
  [[66.4,-22.7],[65.9,-14.5],[64.3,-14.0],[63.4,-19.0],[64.9,-24.0],[66.4,-22.7]],
  // North America (rough)
  [[49,-123],[49,-95],[45,-83],[44,-70],[25,-80],[26,-97],[32,-117],[37,-122],[49,-123]],
  // South America (rough, just enough for Colombia et al.)
  [[12,-72],[-5,-35],[-23,-43],[-34,-58],[-53,-68],[-18,-70],[0,-80],[12,-72]],
  // Japan (main islands, one soft mass)
  [[45.5,141.7],[43.0,145.8],[35.5,140.9],[33.5,135.8],[31.0,130.5],[34.5,129.5],[36.5,136.9],[40.8,140.7],[45.5,141.7]],
  // Australia (rough)
  [[-10.7,142.5],[-16.9,145.8],[-27.5,153.0],[-33.9,151.2],[-38.4,144.9],[-35.0,117.9],
   [-20.3,118.6],[-12.4,130.8],[-10.7,142.5]],
  // New Zealand (rough)
  [[-34.4,172.7],[-36.8,174.8],[-41.3,174.8],[-45.9,170.5],[-43.5,172.6],[-34.4,172.7]],
];

function silhouettePathD(points, projectFn) {
  return points.map(([lat, lon], i) => {
    const [x, y] = projectFn(lat, lon);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ") + " Z";
}

function buildSilhouette(projectFn) {
  return LANDMASSES.map((points) => `<path class="realm-land" d="${silhouettePathD(points, projectFn)}" />`).join("");
}

// Stars whose projected position lands in the same coarse cell are pulled
// apart into a small ring around their shared center — so a dense cluster
// reads as several distinct points of light, not one merged glow.
function spreadOverlaps(points, cellSize) {
  const groups = new Map();
  for (const p of points) {
    const key = `${Math.round(p.x / cellSize)}:${Math.round(p.y / cellSize)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const cx = group.reduce((s, p) => s + p.x, 0) / group.length;
    const cy = group.reduce((s, p) => s + p.y, 0) / group.length;
    const radius = Math.min(cellSize * 0.85, 8 + group.length * 2.6);
    group.forEach((p, i) => {
      const angle = (i / group.length) * Math.PI * 2 - Math.PI / 2;
      p.x = cx + Math.cos(angle) * radius;
      p.y = cy + Math.sin(angle) * radius;
    });
  }
}

// Importance as atmosphere, not radius. The dot itself barely grows; what
// grows is the soft light around it. Genuinely dense countries also get a
// small deterministic scatter of satellite points — a cluster of names,
// not a number.
function weight(count, maxCount) {
  const t = Math.sqrt(count) / Math.sqrt(Math.max(maxCount, 1));
  return {
    dot: 1.7 + t * 1.5,
    glow: 4.5 + t * 8,
    glowOpacity: 0.2 + t * 0.22,
    atmosphere: 16 + t * 52,
    atmosphereOpacity: 0.045 + t * 0.1,
  };
}

// Deterministic pseudo-random satellite offsets, seeded by country code so
// the cluster doesn't reshuffle on every render.
function seededOffsets(code, n, spread) {
  let seed = [...code].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed / 4294967296); };
  const pts = [];
  for (let i = 0; i < n; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = (0.4 + rand() * 0.6) * spread;
    pts.push([Math.cos(angle) * dist, Math.sin(angle) * dist]);
  }
  return pts;
}

const ORDINAL_WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten"];
function spellSmall(n) { return ORDINAL_WORDS[n] || String(n); }
function withCommas(n) { return Number(n || 0).toLocaleString("en-US"); }
function titleCase(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

export function renderRealm(root, data, confidentlySeenKeys) {
  const { el, esc } = renderDeps;
  root.innerHTML = "";

  const rawArtists = Object.values(data?.artists || {})
    .filter((a) => a.country && CENTROIDS[a.country])
    .filter((a) => !confidentlySeenKeys || confidentlySeenKeys.has(normalizeKeyLocal(a.name)));

  const nothingAtAll = !Object.keys(data?.artists || {}).length;
  if (nothingAtAll) {
    root.appendChild(el(`
      <div class="stage-empty">
        <p class="whisper">Realm</p>
        <p class="lede">A wider map of what you listen to.</p>
        <p class="footnote">Still gathering — this fills in after the origins job first runs.</p>
      </div>
    `));
    return;
  }

  const byCountry = new Map();
  for (const a of rawArtists) {
    if (!byCountry.has(a.country)) byCountry.set(a.country, { name: a.countryName || a.country, artists: new Set() });
    byCountry.get(a.country).artists.add(a.name);
  }
  const countries = [...byCountry.entries()]
    .map(([code, v]) => ({ code, name: v.name, artists: [...v.artists], count: v.artists.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  if (!countries.length) {
    root.appendChild(el(`
      <div class="stage-empty">
        <p class="whisper">Realm</p>
        <p class="lede">A wider map of what you listen to.</p>
        <p class="footnote">Still gathering — this fills in after the origins job first runs.</p>
      </div>
    `));
    return;
  }

  const totalArtists = rawArtists.length;
  const dominant = countries[0];
  const singleArtistCount = countries.filter((c) => c.count === 1).length;

  let farthest = countries[0];
  let farthestKm = -1;
  for (const c of countries) {
    const [lat, lon] = CENTROIDS[c.code];
    const km = haversineKm(HOME.lat, HOME.lon, lat, lon);
    if (km > farthestKm) { farthestKm = km; farthest = c; }
  }

  root.appendChild(buildOpening(countries, totalArtists, dominant, farthest, singleArtistCount));

  const maxCount = dominant.count;
  root.appendChild(buildSky(countries, maxCount, "world"));

  const europeCountries = countries.filter((c) => {
    const [lat, lon] = CENTROIDS[c.code];
    return lat >= EUROPE_BOUNDS.latMin && lat <= EUROPE_BOUNDS.latMax &&
           lon >= EUROPE_BOUNDS.lonMin && lon <= EUROPE_BOUNDS.lonMax;
  });
  if (europeCountries.length) {
    root.appendChild(el(`
      <div class="realm-transition">
        <div class="realm-transition-line"></div>
        <p class="realm-transition-label">Closer — where most of it lives</p>
      </div>
    `));
    root.appendChild(buildSky(europeCountries, maxCount, "europe"));
  }
}

function buildOpening(countries, totalArtists, dominant, farthest, singleArtistCount) {
  const { el, esc } = renderDeps;
  const farApart = farthest.code !== dominant.code;
  return el(`
    <div class="opening">
      <p class="whisper">Realm</p>
      <p class="lede">
        ${withCommas(totalArtists)} artist${totalArtists === 1 ? "" : "s"} crossed borders before they found you, from ${countries.length} ${countries.length === 1 ? "country" : "countries"}.<br>
        <em>Most came from ${esc(dominant.name)}.${farApart ? ` One came all the way from ${esc(farthest.name)}.` : ""}</em>
      </p>
      ${singleArtistCount ? `<p class="footnote">${titleCase(spellSmall(singleArtistCount))} ${singleArtistCount === 1 ? "country you've" : "countries you've"} only crossed paths with once.</p>` : ""}
    </div>
  `);
}
