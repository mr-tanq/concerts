// realm.js
//
// "A wider map of what you listen to." Not a political world map — this
// app has no access to accurate country border geometry, and a wrong
// border is worse than no border. Instead: an abstract coordinate space
// (the same hairline-grid language used everywhere else in this app) with
// a pin at each country's approximate centroid. It reads as a map without
// pretending to be cartography.
//
// Built entirely from a static data/artist-origins.json, refreshed weekly
// by a GitHub Action (MusicBrainz, not Last.fm or Deezer — neither of
// those expose country of origin at all).

let renderDeps = null; // { el, esc } injected from app.js

export function initRealm(deps) {
  renderDeps = deps;
}

// Approximate centroids (lat, lon) for countries plausible to show up here.
// Precision to a degree or two is intentional — pins on an abstract grid,
// not a survey. Missing a country here just means it's silently skipped
// rather than guessed at.
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

function project(lat, lon, width, height) {
  const x = ((lon + 180) / 360) * width;
  const y = ((90 - lat) / 180) * height;
  return [x, y];
}

export function renderRealm(root, data) {
  const { el, esc } = renderDeps;
  root.innerHTML = "";

  const artists = Object.values(data?.artists || {}).filter((a) => a.country && CENTROIDS[a.country]);

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

  // Group by country so a country with several artists gets one pin, not
  // several stacked on top of each other.
  const byCountry = new Map(); // code -> { name, artists: Set }
  for (const a of artists) {
    if (!byCountry.has(a.country)) byCountry.set(a.country, { name: a.countryName || a.country, artists: new Set() });
    byCountry.get(a.country).artists.add(a.name);
  }
  const countries = [...byCountry.entries()].map(([code, v]) => ({ code, name: v.name, artists: [...v.artists] }));
  countries.sort((a, b) => b.artists.length - a.artists.length || a.name.localeCompare(b.name));

  const totalArtistsResolved = artists.length;

  root.appendChild(el(`
    <div class="opening">
      <p class="whisper">Realm</p>
      <p class="lede">
        ${countries.length} ${countries.length === 1 ? "country" : "countries"} you've brought into the room.<br>
        <em>${totalArtistsResolved} artist${totalArtistsResolved === 1 ? "" : "s"}, seen live${countries[0] ? ` — most from ${esc(countries[0].name)}` : ""}.</em>
      </p>
    </div>
  `));

  root.appendChild(buildMap(countries));

  const list = el(`<div style="margin-top:12px"></div>`);
  countries.forEach((c) => {
    list.appendChild(el(`
      <div class="recent-row">
        <div class="recent-when" style="flex-basis:auto;text-transform:none;font-size:12px">${esc(c.name)}</div>
        <div class="recent-body"><span>${esc(c.artists.join(", "))}</span></div>
      </div>
    `));
  });
  root.appendChild(list);
}

function buildMap(countries) {
  const { el, esc } = renderDeps;
  const W = 700, H = 350;

  const graticule = [];
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x1] = project(0, lon, W, H);
    graticule.push(`<line x1="${x1}" y1="0" x2="${x1}" y2="${H}" class="realm-grid-line" />`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y1] = project(lat, 0, W, H);
    graticule.push(`<line x1="0" y1="${y1}" x2="${W}" y2="${y1}" class="realm-grid-line ${lat === 0 ? "is-equator" : ""}" />`);
  }

  const pins = countries.map((c) => {
    const [lat, lon] = CENTROIDS[c.code];
    const [x, y] = project(lat, lon, W, H);
    const label = esc(c.name.length > 16 ? c.code : c.name);
    return `
      <g class="realm-pin" transform="translate(${x},${y})">
        <circle class="realm-pin-glow" r="9" />
        <circle class="realm-pin-dot" r="3" />
        <text class="realm-pin-label" x="0" y="-13" text-anchor="middle">${label}</text>
      </g>
    `;
  }).join("");

  const svg = `
    <svg class="realm-map" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${graticule.join("")}
      ${pins}
    </svg>
  `;
  return el(`<div class="realm-map-wrap">${svg}</div>`);
}