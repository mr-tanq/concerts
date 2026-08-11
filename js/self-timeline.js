// self-timeline.js
//
// SELF's signature element: not a bar chart, not a contribution graph — a
// "listening landscape". Time is the visual object here the way geography
// is Realm's and concerts are Archive's. Every trace, every concert dot,
// every editorial moment is derived from data/listening-timeseries.json
// (real weekly playcounts) cross-referenced with the Archive — nothing
// here is a guessed or synthetic distribution.
//
// Two halves:
//   computeListeningLife()   -> pure data: which artists, what shape
//   selectEditorialMoments() -> pure data: the 3 strongest, most diverse
//                                 stories among the curated traces
//   renderListeningLife()    -> the SVG strand visualization + interaction
//   renderEditorialMoments()  -> the 3 large blocks, each with a mini trace

import {
  normalizeKey, fullSeriesFor, detectStayed, detectComebacks, detectObsessions,
  detectPostConcertSurge, detectConcertRevival, buildCanonicalNameIndex, canonicalNameFor,
  humanizeWeeks, humanizeDays, monthYear, spellSmall,
} from "./insights.js";
import { actuallySeenArtistsOf } from "./archive-stats.js";

// ---------- data: which artists, what shape ----------

// Curated, not "top 10 by playcount" — tries to include one strong
// representative of each listening-life archetype the brief asked for,
// then fills any remaining slots by total plays for breadth.
export function computeListeningLife(timeseries, archiveConcerts, options = {}) {
  const maxTraces = options.maxTraces ?? 10;
  const weekStarts = timeseries?.meta?.weekStarts || [];
  if (!weekStarts.length) return { years: [], traces: [] };

  const years = [...new Set(weekStarts.map((w) => Number(w.slice(0, 4))))].sort((a, b) => a - b);
  if (!years.length) return { years: [], traces: [] };
  const currentYear = years[years.length - 1];

  const artists = timeseries.artists || {};
  const canonicalNames = buildCanonicalNameIndex(archiveConcerts);

  const concertsByKey = new Map();
  for (const c of archiveConcerts || []) {
    if (!c.date) continue;
    for (const name of actuallySeenArtistsOf(c)) {
      const k = normalizeKey(name);
      if (!concertsByKey.has(k)) concertsByKey.set(k, []);
      concertsByKey.get(k).push({ date: c.date, venue: c.venue, city: c.city, festivalName: c.festivalName });
    }
  }

  const candidates = [];
  for (const entry of Object.values(artists)) {
    const series = fullSeriesFor(entry, weekStarts);
    const totalPlays = series.reduce((s, w) => s + w.playcount, 0);
    if (totalPlays < 5) continue; // too little signal to draw an honest trace

    const displayName = canonicalNameFor(canonicalNames, entry.name);
    const key = normalizeKey(displayName);

    const yearTotals = {};
    for (const { weekStart, playcount } of series) {
      const y = Number(weekStart.slice(0, 4));
      yearTotals[y] = (yearTotals[y] || 0) + playcount;
    }
    const activeYears = Object.keys(yearTotals).map(Number).filter((y) => yearTotals[y] > 0).sort((a, b) => a - b);
    if (!activeYears.length) continue;
    const firstYear = activeYears[0];
    const lastYear = activeYears[activeYears.length - 1];

    const stayed = detectStayed(displayName, series);
    const comeback = detectComebacks(displayName, series);
    const obsession = detectObsessions(displayName, series);

    const concerts = concertsByKey.get(key) || [];
    let concertEvent = null;
    for (const c of concerts) {
      const surge = detectPostConcertSurge(displayName, series, c.date);
      const revival = detectConcertRevival(displayName, series, c.date);
      const best = [surge, revival].filter(Boolean).sort((a, b) => b.score - a.score)[0];
      if (best && (!concertEvent || best.score > concertEvent.score)) concertEvent = best;
    }

    const isDormant = currentYear - lastYear >= 3 && !comeback;
    const isRecentObsession = obsession && Number(obsession.windowStart.slice(0, 4)) >= currentYear - 2;

    const archetypes = [];
    if (stayed) archetypes.push("longTerm");
    if (comeback) archetypes.push("comeback");
    if (isRecentObsession) archetypes.push("recentObsession");
    if (isDormant) archetypes.push("dormant");
    if (concertEvent) archetypes.push("concertConnected");

    let peakYear = firstYear, peakPlays = -1;
    for (const y of activeYears) { if (yearTotals[y] > peakPlays) { peakYear = y; peakPlays = yearTotals[y]; } }

    candidates.push({
      name: displayName, key, totalPlays, yearTotals, firstYear, lastYear, peakYear,
      liveCount: concerts.length, concerts,
      archetypes, stayed, comeback, obsession, concertEvent,
    });
  }

  const CATEGORIES = ["longTerm", "comeback", "recentObsession", "dormant", "concertConnected"];
  const scoreOf = (c, cat) => {
    if (cat === "longTerm") return c.stayed?.score ?? 0;
    if (cat === "comeback") return c.comeback?.score ?? 0;
    if (cat === "recentObsession") return c.obsession?.score ?? 0;
    if (cat === "concertConnected") return c.concertEvent?.score ?? 0;
    return c.totalPlays;
  };

  const chosenKeys = new Set();
  const traces = [];
  for (const cat of CATEGORIES) {
    if (traces.length >= maxTraces) break;
    const pool = candidates.filter((c) => c.archetypes.includes(cat) && !chosenKeys.has(c.key));
    if (!pool.length) continue;
    pool.sort((a, b) => scoreOf(b, cat) - scoreOf(a, cat));
    chosenKeys.add(pool[0].key);
    traces.push(pool[0]);
  }
  const remaining = candidates.filter((c) => !chosenKeys.has(c.key)).sort((a, b) => b.totalPlays - a.totalPlays);
  for (const c of remaining) {
    if (traces.length >= maxTraces) break;
    chosenKeys.add(c.key);
    traces.push(c);
  }

  // Intensity normalized against each artist's OWN peak year, not the
  // global peak — otherwise one dominant artist flattens everyone else.
  for (const t of traces) {
    const peak = Math.max(1, ...Object.values(t.yearTotals));
    t.yearIntensity = {};
    for (const y of years) t.yearIntensity[y] = Math.min(1, (t.yearTotals[y] || 0) / peak);
  }

  traces.sort((a, b) => a.firstYear - b.firstYear || b.totalPlays - a.totalPlays);
  return { years, traces };
}

// The 3 strongest, most different stories among the CURATED traces (not a
// separate pool) — so each can carry a real fragment of its own visible
// strand. Says less than 3 if fewer genuinely distinct stories exist.
export function selectEditorialMoments(traces) {
  const used = new Set();
  const pick = (predicate, scoreFn) => {
    const pool = traces.filter((t) => !used.has(t.key) && predicate(t));
    if (!pool.length) return null;
    pool.sort((a, b) => scoreFn(b) - scoreFn(a));
    used.add(pool[0].key);
    return pool[0];
  };

  const moments = [];
  const stayedPick = pick((t) => t.stayed, (t) => t.stayed.score);
  if (stayedPick) moments.push({ kind: "stayed", trace: stayedPick });

  const comebackPick = pick((t) => t.comeback, (t) => t.comeback.score);
  if (comebackPick) moments.push({ kind: "comeback", trace: comebackPick });

  const concertPick = pick((t) => t.concertEvent, (t) => t.concertEvent.score);
  if (concertPick) moments.push({ kind: "concert", trace: concertPick });

  if (moments.length < 3) {
    const obsessionPick = pick((t) => t.obsession, (t) => t.obsession.score);
    if (obsessionPick) moments.push({ kind: "obsession", trace: obsessionPick });
  }
  if (moments.length < 3) {
    const dormantPick = pick((t) => t.archetypes.includes("dormant"), (t) => t.totalPlays);
    if (dormantPick) moments.push({ kind: "dormant", trace: dormantPick });
  }
  return moments.slice(0, 3);
}

function momentCopy(m) {
  const t = m.trace;
  switch (m.kind) {
    case "stayed":
      return { kicker: "Stayed", lines: [`${spellSmall(t.stayed.yearSpan)} years in your listening life.`, `${t.firstYear} — ${t.lastYear}.`] };
    case "comeback":
      return { kicker: "Returned", lines: [`${humanizeWeeks(t.comeback.gapWeeks)} disappeared.`, `Then ${monthYear(t.comeback.returnWeekStart)} happened.`] };
    case "concert": {
      const ce = t.concertEvent;
      if (ce.type === "postConcertSurge") {
        return { kicker: "Live changed it", lines: [`You'd barely heard them before the show.`, `Then you saw them live — ${monthYear(ce.concertDate)}.`] };
      }
      return { kicker: "Live changed it", lines: [`${humanizeDays(ce.gapDays)} silent.`, `Then you saw them live — ${monthYear(ce.concertDate)}.`] };
    }
    case "obsession":
      return { kicker: "The obsession", lines: [`${humanizeWeeks(t.obsession.windowWeeks)} in ${monthYear(t.obsession.windowStart)},`, `almost all you played.`] };
    case "dormant":
      return { kicker: "Quiet for now", lines: [`Hasn't come up since ${t.lastYear}.`, `${t.totalPlays.toLocaleString("en-US")} plays before that.`] };
    default:
      return { kicker: "", lines: [] };
  }
}

// ---------- rendering: the strand visualization ----------

const ROW_H = 34;
const YEAR_W = 20; // svg units per year

function strandSegments(trace, years) {
  return years.map((y, i) => {
    const intensity = trace.yearIntensity[y] || 0;
    const h = 2.2 + intensity * 7.5;
    const opacity = 0.1 + intensity * 0.75;
    const x = i * YEAR_W;
    return `<rect x="${x}" y="${(ROW_H - h) / 2}" width="${YEAR_W * 0.92}" height="${h}" rx="${h / 2}" fill="var(--ember)" opacity="${opacity.toFixed(2)}" />`;
  }).join("");
}

function concertMarkers(trace, years) {
  if (!years.length) return "";
  const minYear = years[0];
  return trace.concerts.map((c) => {
    const y = Number(String(c.date).slice(0, 4));
    const month = Number(String(c.date).slice(5, 7)) || 1;
    const idx = y - minYear;
    if (idx < 0 || idx >= years.length) return "";
    const x = idx * YEAR_W + ((month - 0.5) / 12) * YEAR_W;
    return `<circle class="strand-live" cx="${x.toFixed(1)}" cy="${ROW_H / 2}" r="2.1" />`;
  }).join("");
}

export function renderListeningLife(root, life, deps, onViewArtist) {
  const { el, esc } = deps;
  root.innerHTML = "";
  const { years, traces } = life;

  if (!years.length || !traces.length) {
    root.appendChild(el(`
      <div class="life-empty">
        <p class="footnote">Still gathering — the listening life needs enough weekly history behind it before a shape emerges.</p>
      </div>
    `));
    return;
  }

  const wrap = el(`<div class="life-wrap"></div>`);

  const axis = el(`
    <div class="life-axis">
      <span>${years[0]}</span>
      <span class="life-axis-line"></span>
      <span>${years[years.length - 1]}</span>
    </div>
  `);
  wrap.appendChild(axis);

  const rows = el(`<div class="life-rows"></div>`);
  const W = years.length * YEAR_W;

  traces.forEach((t, i) => {
    const row = el(`
      <div class="life-row" data-key="${esc(t.key)}" style="animation-delay:${i * 60}ms">
        <div class="life-row-label">${esc(t.name)}</div>
        <svg class="life-strand" viewBox="0 0 ${W} ${ROW_H}" preserveAspectRatio="none">
          ${strandSegments(t, years)}
          ${concertMarkers(t, years)}
        </svg>
      </div>
    `);
    rows.appendChild(row);
  });
  wrap.appendChild(rows);

  const panel = el(`<div class="life-panel" id="life-panel"></div>`);
  wrap.appendChild(panel);

  function selectTrace(key) {
    rows.querySelectorAll(".life-row").forEach((r) => r.classList.toggle("is-active", r.dataset.key === key));
    rows.classList.add("is-focused");
    const t = traces.find((x) => x.key === key);
    if (!t) return;
    panel.innerHTML = "";
    panel.appendChild(el(`
      <div class="life-panel-inner">
        <h3 class="life-panel-name">${esc(t.name)}</h3>
        <p class="life-panel-stat">${t.totalPlays.toLocaleString("en-US")} plays</p>
        <p class="life-panel-stat">${t.firstYear} — ${t.lastYear}</p>
        ${t.liveCount ? `<p class="life-panel-stat life-panel-live">${spellSmall(t.liveCount)} time${t.liveCount === 1 ? "" : "s"} in the room</p>` : ""}
        <button class="plain-act life-panel-view">View artist →</button>
      </div>
    `));
    panel.querySelector(".life-panel-view").addEventListener("click", () => onViewArtist?.(t.name));
  }

  rows.querySelectorAll(".life-row").forEach((row) => {
    row.addEventListener("click", () => selectTrace(row.dataset.key));
  });

  // Touch scrub: horizontal-only, confined to the rail — never competes
  // with vertical page scroll unless the gesture is clearly sideways.
  const rail = el(`<div class="life-rail"><div class="life-rail-cursor"></div><div class="life-rail-year"></div></div>`);
  wrap.appendChild(rail);
  const cursor = rail.querySelector(".life-rail-cursor");
  const yearLabel = rail.querySelector(".life-rail-year");
  let dragging = false, startX = 0, startY = 0, locked = null;

  function updateScrub(clientX) {
    const rect = rail.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const idx = Math.round(frac * (years.length - 1));
    const y = years[idx];
    cursor.style.left = `${frac * 100}%`;
    yearLabel.style.left = `${frac * 100}%`;
    yearLabel.textContent = String(y);
    cursor.style.opacity = "1";
    yearLabel.style.opacity = "1";
  }

  rail.addEventListener("pointerdown", (e) => {
    dragging = true; locked = null;
    startX = e.clientX; startY = e.clientY;
    rail.setPointerCapture(e.pointerId);
    updateScrub(e.clientX);
  });
  rail.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    if (locked === null) {
      const dx = Math.abs(e.clientX - startX), dy = Math.abs(e.clientY - startY);
      if (dx > 4 || dy > 4) locked = dx > dy ? "x" : "y";
    }
    if (locked !== "x") return;
    updateScrub(e.clientX);
  });
  const endScrub = () => {
    dragging = false;
    cursor.style.opacity = "0";
    yearLabel.style.opacity = "0";
  };
  rail.addEventListener("pointerup", endScrub);
  rail.addEventListener("pointercancel", endScrub);

  root.appendChild(wrap);

  // First trace focuses by default, so the panel never opens empty —
  // matches "lately you keep returning to X" already being the hero's
  // headline elsewhere.
  if (traces.length) selectTrace(traces[traces.length - 1].key);
}

// ---------- rendering: the 3 editorial moments ----------

export function renderEditorialMoments(root, moments, deps, onViewArtist) {
  const { el, esc } = deps;
  root.innerHTML = "";
  if (!moments.length) return;

  moments.forEach((m, i) => {
    const copy = momentCopy(m);
    const t = m.trace;
    const block = el(`
      <div class="moment-block" style="animation-delay:${i * 90}ms">
        <p class="whisper">${esc(copy.kicker)}</p>
        <h3 class="moment-name">${esc(t.name)}</h3>
        ${copy.lines.map((l) => `<p class="moment-line">${esc(l)}</p>`).join("")}
        <button class="plain-act moment-view">View artist →</button>
      </div>
    `);
    block.querySelector(".moment-view").addEventListener("click", () => onViewArtist?.(t.name));
    root.appendChild(block);
  });
}