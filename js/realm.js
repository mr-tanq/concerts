// realm.js
//
// CONSTELLATION ATLAS.
//
// The brief for this file was: stop treating geography as a chart. This
// app has no access to real political border geometry — so rather than
// fake cartography badly, the whole section leans into a different, more
// honest metaphor: the world as a night sky. Every country you've actually
// heard live is a star at its real latitude/longitude. Brightness, size and
// glow are how "importance" is shown — no bars, no grid, no legend table.
// Countries with no connection to your history aren't dimmed, they simply
// don't exist here; the surrounding dark IS "almost disappearing".
//
// Tapping a star doesn't open a card. The sky around it fades, the star
// becomes the center of its own small composition, and the artists from
// that country ignite one by one — each with the actual cities where you
// saw them (pulled straight from the Archive), because the more
// interesting relationship was never "artist → country", it was always
// "artist → the room you were standing in when you heard them".
//
// Built from the same static data/artist-origins.json as before. Nothing
// about the data model changed — only how it's seen.

import { actuallySeenArtistsOf } from "./archive-stats.js";

let renderDeps = null; // { el, esc } injected from app.js
let archiveConcertsRef = []; // for the "seen in <cities>" line inside focus mode

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

// Importance as light, not size on a bar chart. Square-root scaling so one
// dominant country doesn't swallow the composition — it should feel
// brighter, not just bigger.
function weight(count, maxCount) {
  const t = Math.sqrt(count) / Math.sqrt(Math.max(maxCount, 1));
  return {
    dot: 2.2 + t * 4.2,
    glow: 7 + t * 26,
    glowOpacity: 0.12 + t * 0.26,
  };
}

const ORDINAL_WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten"];
function spellSmall(n) { return ORDINAL_WORDS[n] || String(n); }

export function renderRealm(root, data, confidentlySeenKeys) {
  const { el, esc } = renderDeps;
  root.innerHTML = "";

  const rawArtists = Object.values(data?.artists || {})
    .filter((a) => a.country && CENTROIDS[a.country])
    .filter((a) => !confidentlySeenKeys || confidentlySeenKeys.has(normalizeKeyLocal(a.name)));

  if (!Object.keys(data?.artists || {}).length) {
    root.appendChild(el(`
      <div class="stage-empty">
        <p class="whisper">Realm</p>
        <p class="lede">A wider map of what you listen to.</p>
        <p class="footnote">Still gathering — this fills in after the origins job first runs.</p>
      </div>
    `));
    return;
  }

  // Group by country.
  const byCountry = new Map(); // code -> { name, artists: Set }
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

  // Farthest country from home, by real distance — the "one came all the
  // way from…" line, computed rather than guessed.
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

// The editorial opening — a sentence about a life, not a stat block.
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

function withCommas(n) { return Number(n || 0).toLocaleString("en-US"); }
function titleCase(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// Builds one sky — world overview or the closer Europe composition. Same
// visual language, different scale and bounds.
function buildSky(countries, maxCount, mode) {
  const { el } = renderDeps;
  const isEurope = mode === "europe";
  const W = isEurope ? 400 : 700;
  const H = isEurope ? 460 : 350;
  const cellSize = isEurope ? 44 : 15;

  const points = countries.map((c) => {
    const [lat, lon] = CENTROIDS[c.code];
    const [x, y] = isEurope ? projectInBounds(lat, lon, EUROPE_BOUNDS, W, H) : project(lat, lon, W, H);
    return { x, y, country: c };
  });
  spreadOverlaps(points, cellSize);

  const stars = points.map(({ x, y, country }, i) => {
    const wgt = weight(country.count, maxCount);
    const isDominant = country.count === maxCount && maxCount > 1;
    const label = isEurope ? `<text class="realm-star-label" x="0" y="${-(wgt.glow * 0.55 + 8)}" text-anchor="middle">${escSafe(country.name)}</text>` : "";
    return `
      <g class="realm-star ${isDominant ? "is-dominant" : ""}" data-code="${country.code}" data-idx="${i}"
         transform="translate(${x},${y})">
        <g class="realm-star-anim" style="animation-delay:${(i * 90)}ms">
          ${isDominant ? `<circle class="realm-star-halo" r="${wgt.glow * 1.7}" />` : ""}
          <circle class="realm-star-glow" r="${wgt.glow}" style="opacity:${wgt.glowOpacity}" />
          <circle class="realm-star-dot" r="${wgt.dot}" />
          ${label}
          <circle class="realm-star-hit" r="18" />
        </g>
      </g>
    `;
  }).join("");

  const wrap = el(`
    <div class="realm-sky-wrap ${isEurope ? "is-europe" : "is-world"}">
      <svg class="realm-sky" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="realm-vignette-${mode}" cx="50%" cy="45%" r="75%">
            <stop offset="0%" stop-color="#0e0e13" stop-opacity="0.55" />
            <stop offset="100%" stop-color="#08080a" stop-opacity="0" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="${W}" height="${H}" fill="url(#realm-vignette-${mode})" />
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

function escSafe(s) {
  const { esc } = renderDeps;
  return esc(s);
}

// ---------- focus mode ----------
//
// No modal, no card: the tapped star's own sky dims around it, the star
// becomes the center of a small composition, and its artists ignite one at
// a time — each with the real cities you actually stood in for them.

function citiesForArtist(artistName) {
  const key = normalizeKeyLocal(artistName);
  const cities = [];
  const seen = new Set();
  for (const c of archiveConcertsRef) {
    if (!c.city || seen.has(c.city)) continue;
    if (actuallySeenArtistsOf(c).some((n) => normalizeKeyLocal(n) === key)) {
      cities.push(c.city);
      seen.add(c.city);
    }
  }
  return cities;
}

function countryStatement(country) {
  if (country.count === 1) return `The only artist from here — so far.`;
  return `${withCommas(country.count)} artists, one country.`;
}

function enterFocus(wrap, country, starEl) {
  const { el, esc } = renderDeps;
  wrap.classList.add("is-focused");
  starEl.classList.add("is-active");

  const rect = starEl.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const originX = ((rect.left + rect.width / 2 - wrapRect.left) / wrapRect.width) * 100;
  const originY = ((rect.top + rect.height / 2 - wrapRect.top) / wrapRect.height) * 100;

  const panel = el(`
    <div class="realm-focus" style="transform-origin:${originX}% ${originY}%">
      <button class="realm-focus-close">Back to the sky</button>
      <p class="whisper">${country.artists.length} ${country.artists.length === 1 ? "artist" : "artists"}</p>
      <h2 class="realm-focus-name">${esc(country.name)}</h2>
      <p class="lede realm-focus-statement">${countryStatement(country)}</p>
      <div class="realm-focus-list"></div>
    </div>
  `);

  const list = panel.querySelector(".realm-focus-list");
  country.artists.forEach((name, i) => {
    const cities = citiesForArtist(name);
    const row = el(`
      <div class="realm-focus-artist" style="animation-delay:${180 + i * 110}ms">
        <div class="realm-focus-artist-name">${esc(name)}</div>
        ${cities.length ? `<div class="realm-focus-artist-cities">Seen in ${esc(cities.join(", "))}</div>` : ""}
      </div>
    `);
    list.appendChild(row);
  });

  panel.querySelector(".realm-focus-close").addEventListener("click", () => {
    panel.remove();
    wrap.classList.remove("is-focused");
    starEl.classList.remove("is-active");
  });

  wrap.appendChild(panel);
}
