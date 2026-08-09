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
// grows is soft light and a scatter of sparks — never a bigger disc.
// Compressed hard after the first pass looked too much like a bubble chart
// even with a big soft circle: the fix wasn't just size, it was giving the
// glow an actual falloff (a radial gradient, not a flat fill) so it reads
// as light dissipating rather than a shape with an edge.
function weight(count, maxCount) {
  const t = Math.sqrt(count) / Math.sqrt(Math.max(maxCount, 1));
  return {
    dot: 1.6 + t * 1.2,
    glow: 4 + t * 6,
    glowOpacity: 0.22 + t * 0.2,
    atmosphere: 9 + t * 26,
    atmosphereOpacity: 0.16 + t * 0.26,
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
// ---------- label placement ----------
//
// Only countries that earn one get a label at rest — a single artist
// doesn't need to announce itself next to a country with thirty. For the
// ones that do, six candidate positions are tried around the star in
// priority order; the first that doesn't collide with an already-placed
// label wins. Anything pushed away from the simple "just above" position
// gets a thin leader line back to its star, so displacement never reads
// as disconnection.

function estimateLabelBox(text, fontSize, lx, ly, anchor) {
  const w = text.length * fontSize * 0.56;
  const h = fontSize * 1.15;
  const left = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
  return { minX: left, maxX: left + w, minY: ly - h, maxY: ly + h * 0.25, w, h };
}

function boxesOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function layoutLabels(points, isEurope, weightOf) {
  const fontSize = isEurope ? 11 : 9.5;
  const sorted = [...points].sort((a, b) => b.country.count - a.country.count);
  const topSet = new Set(sorted.slice(0, isEurope ? 6 : 5).map((p) => p.country.code));

  const placedBoxes = [];
  const results = [];

  for (const p of sorted) {
    const isPriority = topSet.has(p.country.code);
    const eligible = isPriority || p.country.count > 1;
    if (!eligible) continue;

    const wgt = weightOf(p.country.count);
    const base = wgt.atmosphere * 0.55 + 8;
    const text = p.country.name;

    const candidates = [
      { lx: p.x, ly: p.y - base, anchor: "middle" },
      { lx: p.x + base * 0.85, ly: p.y + 3, anchor: "start" },
      { lx: p.x - base * 0.85, ly: p.y + 3, anchor: "end" },
      { lx: p.x, ly: p.y + base + fontSize, anchor: "middle" },
      { lx: p.x + base * 0.7, ly: p.y - base * 0.7, anchor: "start" },
      { lx: p.x - base * 0.7, ly: p.y - base * 0.7, anchor: "end" },
    ];

    // Priority countries earn the full search — displaced with a leader
    // line rather than dropped. Everything else gets one clean try at the
    // simple "just above" position; if that collides, it goes dark rather
    // than crowding the composition with a forced, awkward placement.
    const passes = isPriority ? 2 : 1;
    const candidateSet = isPriority ? candidates : candidates.slice(0, 1);

    let chosen = null;
    let chosenIdx = -1;
    for (let pass = 0; pass < passes && !chosen; pass++) {
      const scale = pass === 0 ? 1 : 1.6;
      for (let i = 0; i < candidateSet.length; i++) {
        const cand = candidateSet[i];
        const lx = pass === 0 ? cand.lx : p.x + (cand.lx - p.x) * scale;
        const ly = pass === 0 ? cand.ly : p.y + (cand.ly - p.y) * scale;
        const box = estimateLabelBox(text, fontSize, lx, ly, cand.anchor);
        if (!placedBoxes.some((b) => boxesOverlap(b, box))) {
          chosen = { lx, ly, anchor: cand.anchor, box };
          chosenIdx = i;
          break;
        }
      }
    }
    if (!chosen) continue; // says less, per the brief, rather than crowd or force it

    placedBoxes.push(chosen.box);
    results.push({
      code: p.country.code,
      x: p.x, y: p.y,
      lx: chosen.lx, ly: chosen.ly, anchor: chosen.anchor,
      leader: chosenIdx > 0,
      text, fontSize,
    });
  }
  return results;
}

function buildSky(countries, maxCount, mode) {
  const { el, esc } = renderDeps;
  const isEurope = mode === "europe";
  const W = isEurope ? 400 : 700;
  const H = isEurope ? 460 : 440;
  const cellSize = isEurope ? 44 : 15;
  const projectFn = isEurope
    ? (lat, lon) => projectInBounds(lat, lon, EUROPE_BOUNDS, W, H)
    : (lat, lon) => project(lat, lon, W, H);

  const points = countries.map((c) => {
    const [lat, lon] = CENTROIDS[c.code];
    const [x, y] = projectFn(lat, lon);
    return { x, y, country: c };
  });
  spreadOverlaps(points, cellSize);

  const weightOf = (count) => weight(count, maxCount);

  const stars = points.map(({ x, y, country }, i) => {
    const wgt = weightOf(country.count);
    const isDominant = country.count === maxCount && maxCount > 1;
    const satellites = country.count >= 2
      ? seededOffsets(country.code, Math.min(country.count - 1, 7), wgt.atmosphere * 0.7)
          .map(([dx, dy]) => `<circle class="realm-star-sat" cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="0.85" />`)
          .join("")
      : "";
    return `
      <g class="realm-star ${isDominant ? "is-dominant" : ""}" data-code="${country.code}" data-idx="${i}" transform="translate(${x},${y})">
        <g class="realm-star-anim" style="animation-delay:${(i * 90)}ms">
          <circle class="realm-star-atmosphere" r="${wgt.atmosphere}" fill="url(#realm-star-glow-${mode})" style="opacity:${wgt.atmosphereOpacity}" />
          <circle class="realm-star-glow" r="${wgt.glow}" style="opacity:${wgt.glowOpacity}" />
          <circle class="realm-star-dot" r="${wgt.dot}" />
          ${satellites}
          <circle class="realm-star-hit" r="18" />
        </g>
      </g>
    `;
  }).join("");

  const labels = layoutLabels(points, isEurope, weightOf);
  const labelMarkup = labels.map((lab) => {
    const leaderLine = lab.leader
      ? `<line class="realm-leader" x1="${lab.x.toFixed(1)}" y1="${lab.y.toFixed(1)}" x2="${lab.lx.toFixed(1)}" y2="${(lab.ly - lab.fontSize * 0.35).toFixed(1)}" />`
      : "";
    return `
      ${leaderLine}
      <text class="realm-star-label" x="${lab.lx.toFixed(1)}" y="${lab.ly.toFixed(1)}" text-anchor="${lab.anchor}" style="font-size:${lab.fontSize}px">${esc(lab.text)}</text>
    `;
  }).join("");

  const wrap = el(`
    <div class="realm-sky-wrap ${isEurope ? "is-europe" : "is-world"}">
      <svg class="realm-sky" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="realm-vignette-${mode}" cx="50%" cy="45%" r="75%">
            <stop offset="0%" stop-color="#0e0e13" stop-opacity="0.5" />
            <stop offset="100%" stop-color="#08080a" stop-opacity="0" />
          </radialGradient>
          <radialGradient id="realm-star-glow-${mode}" cx="50%" cy="50%" r="50%">
            <stop offset="0%" class="realm-glow-stop-in" />
            <stop offset="100%" class="realm-glow-stop-out" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="${W}" height="${H}" fill="url(#realm-vignette-${mode})" />
        <g class="realm-land-layer">${buildSilhouette(projectFn)}</g>
        <g class="realm-leaders">${labelMarkup}</g>
        ${stars}
      </svg>
    </div>
  `);

  wrap.querySelectorAll(".realm-star").forEach((starEl) => {
    starEl.addEventListener("click", () => {
      const code = starEl.dataset.code;
      const country = countries.find((c) => c.code === code);
      if (country) enterFocus(wrap, country, starEl);
    });
  });

  return wrap;
}

// ---------- the journey: origin → encounter ----------
//
// Groups this country's artists by the actual cities you saw them in
// (from the Archive, via actuallySeenArtistsOf so curation is respected),
// each city carrying its earliest date — so "seen in Utrecht" becomes a
// place along a timeline, not a stray fact.

function journeyForCountry(country) {
  const key = normalizeKeyLocal;
  const artistKeys = new Set(country.artists.map(key));
  // Keyed by date+city, not city alone — returning to the same city on a
  // different night is a different encounter and needs its own stop, or
  // every additional time you went back to see them again in a familiar
  // room would silently disappear into the first visit.
  const stopsByKey = new Map();

  for (const c of archiveConcertsRef) {
    if (!c.city || !c.date) continue;
    const matched = actuallySeenArtistsOf(c).filter((n) => artistKeys.has(key(n)));
    if (!matched.length) continue;
    const stopKey = `${c.date}|${c.city}`;
    if (!stopsByKey.has(stopKey)) stopsByKey.set(stopKey, { city: c.city, date: c.date, artists: new Set() });
    const entry = stopsByKey.get(stopKey);
    for (const name of matched) {
      const canonical = country.artists.find((a) => key(a) === key(name)) || name;
      entry.artists.add(canonical);
    }
  }

  return [...stopsByKey.values()]
    .map((s) => ({ city: s.city, artists: [...s.artists], firstDate: s.date }))
    .sort((a, b) => String(a.firstDate || "9999").localeCompare(String(b.firstDate || "9999")));
}

// How many of this country's cities each artist actually appears in —
// repetition made visible (a small mark) instead of the same name just
// showing up again with nothing acknowledging it's the same thread.
function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  const suffix = ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${suffix}`;
}

// Not generic. Looks for something actually true about this country's
// shape before saying anything at all — says less when there's nothing
// worth the sentence.

function countryObservation(country, journey) {
  const artistCount = country.artists.length;
  if (artistCount === 1) return `The only artist from here — so far.`;

  const distinctCities = [...new Set(journey.map((j) => j.city))];
  const cityCount = distinctCities.length;
  const allDates = journey.map((j) => j.firstDate).filter(Boolean).sort();
  const spanYears = allDates.length >= 2
    ? Number(allDates[allDates.length - 1].slice(0, 4)) - Number(allDates[0].slice(0, 4))
    : 0;

  if (cityCount <= 1) {
    const cityName = distinctCities[0];
    return cityName
      ? `${titleCase(spellSmall(artistCount))} artists, always in ${cityName}.`
      : `${titleCase(spellSmall(artistCount))} artists, one country.`;
  }
  if (spanYears >= 3) {
    return `${titleCase(spellSmall(artistCount))} artists, ${spellSmall(cityCount)} cities. Years apart, they kept finding you.`;
  }
  return `${titleCase(spellSmall(artistCount))} artists across ${spellSmall(cityCount)} cities.`;
}

function enterFocus(wrap, country, starEl) {
  wrap.classList.add("is-focused");
  starEl.classList.add("is-active");

  // The rest of the sky dims first — a beat where only this country's
  // light remains — and only then does the detail rise. Isolating a
  // memory, not opening a screen. Timing matches the CSS dim transition.
  window.setTimeout(() => revealFocusPanel(wrap, country, starEl), 640);
}

function revealFocusPanel(wrap, country, starEl) {
  const { el, esc } = renderDeps;
  if (!wrap.isConnected) return;

  const rect = starEl.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const originX = ((rect.left + rect.width / 2 - wrapRect.left) / wrapRect.width) * 100;
  const originY = ((rect.top + rect.height / 2 - wrapRect.top) / wrapRect.height) * 100;

  const journey = journeyForCountry(country);

  const panel = el(`
    <div class="realm-focus" style="transform-origin:${originX}% ${originY}%">
      <button class="realm-focus-close">Back to the sky</button>
      <p class="whisper">${country.artists.length} ${country.artists.length === 1 ? "artist" : "artists"}</p>
      <h2 class="realm-focus-name">${esc(country.name)}</h2>
      <p class="lede realm-focus-statement">${countryObservation(country, journey)}</p>
      <div class="realm-journey"></div>
    </div>
  `);

  const journeyHost = panel.querySelector(".realm-journey");
  if (journey.length) {
    journeyHost.appendChild(el(`<div class="realm-journey-spine"></div>`));
const seenSoFar = new Map();
    journey.forEach((stop, i) => {
      const year = stop.firstDate ? stop.firstDate.slice(0, 4) : "";
      const artistsMarkup = stop.artists.map((name) => {
        const occurrence = (seenSoFar.get(name) || 0) + 1;
        seenSoFar.set(name, occurrence);
        const marker = occurrence > 1 ? `<span class="realm-journey-repeat">${ordinalSuffix(occurrence)}</span>` : "";
        return `<span class="realm-journey-artist">${esc(name)}${marker}</span>`;
      }).join(", ");
      const row = el(`
        <div class="realm-journey-stop" data-stop>
          <div class="realm-journey-dot"></div>
          <div class="realm-journey-city">${esc(stop.city)}${year ? `<span class="realm-journey-year">${year}</span>` : ""}</div>
          <div class="realm-journey-artists">${artistsMarkup}</div>
        </div>
      `);
      journeyHost.appendChild(row);
    });
  } else {
    // Known to have played, no confirmed night in the Archive yet.
    country.artists.forEach((name, i) => {
      journeyHost.appendChild(el(`
        <div class="realm-journey-stop is-unplaced" style="animation-delay:${180 + i * 110}ms">
          <div class="realm-journey-dot"></div>
          <div class="realm-journey-artists">${esc(name)}</div>
        </div>
      `));
    });
  }

  panel.querySelector(".realm-focus-close").addEventListener("click", () => {
    panel.remove();
    wrap.classList.remove("is-focused");
    starEl.classList.remove("is-active");
  });

  wrap.appendChild(panel);
}
