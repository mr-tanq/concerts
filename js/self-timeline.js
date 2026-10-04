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
const DAY_MS = 86400000;

// A Dutch calendar week, independent of the browser's timezone and DST.
export function listeningStoryWeek(now = new Date()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid story date");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).map(p => [p.type, p.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return { start: day.toISOString().slice(0, 10), index: Math.floor((day.getTime() - Date.UTC(2020, 0, 6)) / (7 * DAY_MS)) };
}

function storyDate(trace, category) {
  if (category === "comeback") return trace.comeback?.returnWeekStart;
  if (category === "recentObsession") return trace.obsession?.windowStart;
  if (category === "concertConnected") return trace.concertEvent?.concertDate;
  return trace.lastActiveWeek;
}

function recentlyRecorded(date, week) {
  const age = (Date.parse(week.start) - Date.parse(date)) / DAY_MS;
  return Number.isFinite(age) && age >= 0 && age <= 180;
}

// Two weeks favour current chapters; every third week revisits older ones.
function storyPool(pool, category, score, week) {
  const recent = pool.filter(t => recentlyRecorded(storyDate(t, category), week));
  const older = pool.filter(t => !recentlyRecorded(storyDate(t, category), week));
  const preferred = week.index % 3 !== 0 ? recent : older;
  const ranked = [...(preferred.length ? preferred : pool)].sort((a, b) =>
    score(b) - score(a) || b.totalPlays - a.totalPlays || a.key.localeCompare(b.key));
  const threshold = (score(ranked[0]) || 0) * 0.5;
  return ranked.filter(t => score(t) >= threshold).slice(0, 12);
}

export function computeListeningLife(timeseries, archiveConcerts, options = {}) {
  const maxTraces = options.maxTraces ?? 10;
  const storyWeek = listeningStoryWeek(options.now);
  const weekStarts = timeseries?.meta?.weekStarts || [];
  if (!weekStarts.length) return { years: [], traces: [], allTraces: [], lastUpdated: timeseries?.meta?.lastUpdated };

  const years = [...new Set(weekStarts.map((w) => Number(w.slice(0, 4))))].sort((a, b) => a - b);
  if (!years.length) return { years: [], traces: [], allTraces: [], lastUpdated: timeseries?.meta?.lastUpdated };
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
      lastActiveWeek: series.filter(w => w.playcount > 0).at(-1)?.weekStart,
      liveCount: concerts.length, concerts,
      archetypes, stayed, comeback, obsession, concertEvent,
    });
  }

  const CATEGORIES = ["longTerm", "comeback", "recentObsession", "concertConnected"];
  if (storyWeek.index % 3 === 0) CATEGORIES.push("dormant");
  const scoreOf = (c, cat) => {
    if (cat === "longTerm") return c.stayed?.score ?? 0;
    if (cat === "comeback") return c.comeback?.score ?? 0;
    if (cat === "recentObsession") return c.obsession?.score ?? 0;
    if (cat === "concertConnected") return c.concertEvent?.score ?? 0;
    return c.totalPlays;
  };
  const chosenKeys = new Set(), traces = [];
  const choose = (trace, category) => {
    trace.selectedFor = category;
    chosenKeys.add(trace.key);
    traces.push(trace);
  };
  for (const cat of CATEGORIES) {
    if (traces.length >= maxTraces) break;
    const pool = candidates.filter(c => c.archetypes.includes(cat) && !chosenKeys.has(c.key));
    if (!pool.length) continue;
    const meaningful = pool.filter(c => c.totalPlays >= 20);
    const rotating = storyPool(meaningful.length ? meaningful : pool, cat, c => scoreOf(c, cat), storyWeek);
    const cycle = Math.floor(storyWeek.index / 3);
    const rotation = storyWeek.index % 3 === 0 ? cycle : cycle * 2 + storyWeek.index % 3 - 1;
    choose(rotating[((rotation % rotating.length) + rotating.length) % rotating.length], cat);
  }
  let remaining = candidates.filter(c => !chosenKeys.has(c.key));
  if (storyWeek.index % 3 !== 0) {
    const active = remaining.filter(c => !c.archetypes.includes("dormant"));
    if (active.length >= maxTraces - traces.length) remaining = active;
  }
  const recent = remaining.filter(c => recentlyRecorded(c.lastActiveWeek, storyWeek));
  if (storyWeek.index % 3 !== 0 && recent.length >= maxTraces - traces.length) remaining = recent;
  remaining.sort((a, b) => b.totalPlays - a.totalPlays || a.key.localeCompare(b.key));
  const breadth = remaining.slice(0, Math.max(30, maxTraces));
  const places = Math.min(maxTraces - traces.length, breadth.length);
  for (let i = 0; i < places; i++) {
    const offset = ((storyWeek.index * Math.max(1, places) + i) % breadth.length + breadth.length) % breadth.length;
    choose(breadth[offset], "mostPlayed");
  }

  // Intensity normalized against each artist's OWN peak year, not the
  // global peak — otherwise one dominant artist flattens everyone else.
  for (const t of candidates) {
    const peak = Math.max(1, ...Object.values(t.yearTotals));
    t.yearIntensity = {};
    for (const y of years) t.yearIntensity[y] = Math.min(1, (t.yearTotals[y] || 0) / peak);
  }

  traces.sort((a, b) => a.firstYear - b.firstYear || b.totalPlays - a.totalPlays);
  const allTraces = [...candidates].sort((a, b) => b.totalPlays - a.totalPlays || a.name.localeCompare(b.name));
  return { years, traces, allTraces, storyWeek, lastUpdated: timeseries?.meta?.lastUpdated, backfillComplete: timeseries?.meta?.backfillComplete };
}

// The 3 strongest, most different stories among the CURATED traces (not a
// separate pool) — so each can carry a real fragment of its own visible
// strand. Says less than 3 if fewer genuinely distinct stories exist.
export function selectEditorialMoments(traces, options = {}) {
  const week = options.storyWeek || listeningStoryWeek(options.now);
  const kinds = [
    ["stayed", "longTerm", t => t.stayed],
    ["comeback", "comeback", t => t.comeback],
    ["obsession", "recentObsession", t => t.obsession],
    ["concert", "concertConnected", t => t.concertEvent],
    ["dormant", "dormant", t => t.archetypes.includes("dormant")],
  ];
  const moments = [], used = new Set();
  const ordered = kinds.map(([kind, category, qualifies], i) => {
    const representative = traces.find(t => t.selectedFor === category && qualifies(t));
    return { kind, category, qualifies, representative, order: (i - week.index % 4 + 4) % 4,
      recent: category !== "dormant" && category !== "longTerm" && representative && recentlyRecorded(storyDate(representative, category), week) };
  }).sort((a, b) => Number(Boolean(b.recent)) - Number(Boolean(a.recent)) || a.order - b.order);
  for (const item of ordered) {
    if (moments.length === 3) break;
    const trace = item.representative;
    if (trace && !used.has(trace.key)) {
      moments.push({ kind: item.kind, trace });
      used.add(trace.key);
    }
  }
  for (const item of ordered) {
    if (moments.length === 3) break;
    if (moments.some(m => m.kind === item.kind)) continue;
    const pool = traces.filter(t => !used.has(t.key) && item.qualifies(t));
    pool.sort((a, b) => b.totalPlays - a.totalPlays || a.key.localeCompare(b.key));
    if (pool.length) {
      const trace = pool[((week.index % pool.length) + pool.length) % pool.length];
      moments.push({ kind: item.kind, trace });
      used.add(trace.key);
    }
  }
  return moments;
}

function momentCopy(m) {
  const t = m.trace;
  switch (m.kind) {
    case "stayed":
      return { kicker: "Stayed", lines: [`Listening in ${spellSmall(t.stayed.yearSpan)} different years.`, `${t.firstYear} — ${t.lastYear}.`] };
    case "comeback":
      return { kicker: "Returned", lines: [`${humanizeWeeks(t.comeback.gapWeeks)} without a recorded weekly-chart play.`, `Back in the charts in ${monthYear(t.comeback.returnWeekStart)}.`] };
    case "concert": {
      const ce = t.concertEvent;
      if (ce.type === "postConcertSurge") {
        return { kicker: "After the show", lines: [`${ce.afterPlays.toLocaleString("en-US")} recorded plays in the month after the concert.`, `You saw them live in ${monthYear(ce.concertDate)}.`] };
      }
      return { kicker: "After the show", lines: [`${ce.afterPlays.toLocaleString("en-US")} recorded plays in the two months after the concert.`, `You saw them live in ${monthYear(ce.concertDate)}.`] };
    }
    case "obsession":
      return { kicker: "The obsession", lines: [`${t.obsession.windowPlays.toLocaleString("en-US")} plays over ${humanizeWeeks(t.obsession.windowWeeks)}, starting ${monthYear(t.obsession.windowStart)}.`, `${Math.round(t.obsession.share * 100)}% of their recorded plays fell in that stretch.`] };
    case "dormant":
      return { kicker: "Quiet for now", lines: [`No recorded weekly-chart plays since ${t.lastYear}.`, `${t.totalPlays.toLocaleString("en-US")} recorded plays before that.`] };
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

export function listeningStoryReason(trace) {
  switch (trace.selectedFor) {
    case "longTerm": return "Listening across many years";
    case "comeback": return "A return after a long gap";
    case "recentObsession": return "A concentrated listening stretch";
    case "dormant": return "An older chapter, quiet lately";
    case "concertConnected": return "Listening connected to a concert";
    default: return "One of your most played in the recorded charts";
  }
}

export function filterListeningArtists(traces, query = "") {
  const key = normalizeKey(query);
  return traces.filter((t) => normalizeKey(t.name).includes(key));
}

export function listeningSnapshotLabel(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "Update date unavailable";
  return "Updated " + date.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/Amsterdam",
  });
}

export function renderListeningLife(root, life, deps, onViewArtist) {
  const { el, esc } = deps;
  root.innerHTML = "";
  const { years, traces } = life;
  const allTraces = life.allTraces || traces;

  if (!years.length || !traces.length) {
    root.appendChild(el('<div class="life-wrap"><p class="life-note">Still gathering — more weekly listening history is needed.</p></div>'));
    return;
  }

  const wrap = el('<div class="life-wrap"></div>');
  const controls = el('<div class="life-controls" role="group" aria-label="Listening life view"></div>');
  const storiesButton = el('<button type="button" class="life-mode" aria-pressed="true">Stories</button>');
  const moreButton = el('<button type="button" class="life-mode" aria-pressed="false">More artists</button>');
  controls.appendChild(storiesButton);
  controls.appendChild(moreButton);
  wrap.appendChild(controls);

  const snapshot = el('<p class="life-snapshot"></p>');
  snapshot.textContent = listeningSnapshotLabel(life.lastUpdated);
  wrap.appendChild(snapshot);
  const explanation = el('<p class="life-note"></p>');
  wrap.appendChild(explanation);

  const browser = el('<div class="life-browser" hidden></div>');
  const searchLabel = el('<label class="life-search-label" for="life-artist-search">Find an artist</label>');
  const search = el('<input id="life-artist-search" class="life-search" type="search" placeholder="Artist name" autocomplete="off" spellcheck="false" />');
  browser.appendChild(searchLabel);
  browser.appendChild(search);
  wrap.appendChild(browser);

  wrap.appendChild(el(
    '<div class="life-axis"><span>' + years[0] +
    '</span><span class="life-axis-line"></span><span>' + years[years.length - 1] + '</span></div>'
  ));
  const rows = el('<div class="life-rows"></div>');
  wrap.appendChild(rows);
  const results = el('<p class="life-results" role="status" aria-live="polite"></p>');
  wrap.appendChild(results);

  const pager = el('<div class="life-pager" role="group" aria-label="Artist pages" hidden></div>');
  const previous = el('<button type="button" class="life-page">Previous</button>');
  const pageLabel = el('<span class="life-page-label"></span>');
  const next = el('<button type="button" class="life-page">Next</button>');
  pager.appendChild(previous);
  pager.appendChild(pageLabel);
  pager.appendChild(next);
  wrap.appendChild(pager);

  const panel = el('<div class="life-panel" role="region" aria-label="Selected artist"></div>');
  wrap.appendChild(panel);
  const method = el('<details class="life-method"></details>');
  method.appendChild(el('<summary>How these artists are chosen</summary>'));
  method.appendChild(el('<p>Stories rotates weekly through artists heard across many years, returns after gaps, concentrated listening stretches and listening linked to concerts. Recent chapters receive priority; every third week also revisits older chapters. Remaining places rotate among your most played in the recorded charts.</p>'));
  method.appendChild(el('<p>More artists includes everyone with at least five recorded plays, ordered by recorded plays. This history uses the top 40 artists in each weekly chart, so counts and gaps may omit quieter listening. Each strand shows activity relative to that artist’s own busiest year; dots mark attended concerts.</p>'));
  method.appendChild(el('<p>Stories changes on Mondays using the week in the Netherlands. The same history gives the same selection within that week. History has its own scheduled Monday update; its snapshot date is shown above.</p>'));
  wrap.appendChild(method);

  const PAGE_SIZE = 20;
  const W = years.length * YEAR_W;
  let mode = "stories", page = 0, visible = [];
  const selectedByMode = { stories: null, more: null };

  function selectTrace(key) {
    const t = visible.find((x) => x.key === key);
    if (!t) return;
    selectedByMode[mode] = key;
    rows.querySelectorAll(".life-row").forEach((r) => {
      const active = r.dataset.key === key;
      r.classList.toggle("is-active", active);
      r.setAttribute("aria-pressed", String(active));
    });
    panel.innerHTML = "";
    panel.appendChild(el(
      '<h3 class="life-panel-name">' + esc(t.name) + '</h3>'
    ));
    const facts = el('<p class="life-panel-stat"></p>');
    facts.textContent = t.totalPlays.toLocaleString("en-US") + " recorded plays · " + t.firstYear + "–" + t.lastYear;
    panel.appendChild(facts);
    if (mode === "stories") {
      const reason = el('<p class="life-panel-reason"></p>');
      reason.textContent = "Why this story: " + listeningStoryReason(t);
      panel.appendChild(reason);
    }
    if (t.liveCount) {
      const live = el('<p class="life-panel-stat life-panel-live"></p>');
      live.textContent = spellSmall(t.liveCount) + " time" + (t.liveCount === 1 ? "" : "s") + " in the room";
      panel.appendChild(live);
    }
    const view = el('<button type="button" class="plain-act life-panel-view">View artist →</button>');
    view.addEventListener("click", () => onViewArtist?.(t.name));
    panel.appendChild(view);
  }

  function draw() {
    const browse = mode === "more";
    browser.hidden = !browse;
    storiesButton.setAttribute("aria-pressed", String(!browse));
    moreButton.setAttribute("aria-pressed", String(browse));
    explanation.textContent = browse
      ? "Find your artists beyond the stories. Ordered by recorded weekly-chart plays."
      : traces.length + " stories for this week. Recent chapters and older discoveries, changing on Mondays. Select a strand to see why it is here.";
    const filtered = browse ? filterListeningArtists(allTraces, search.value) : traces;
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, pages - 1));
    visible = browse ? filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : filtered;
    rows.innerHTML = "";
    panel.innerHTML = "";
    panel.hidden = !visible.length;
    visible.forEach((t, i) => {
      const row = el(
        '<button type="button" class="life-row" data-key="' + esc(t.key) +
        '" aria-label="' + esc(t.name) + ', ' + t.totalPlays.toLocaleString("en-US") +
        ' recorded plays" aria-pressed="false" style="animation-delay:' + i * 25 + 'ms">' +
        '<span class="life-row-label">' + esc(t.name) + '</span>' +
        '<svg class="life-strand" aria-hidden="true" viewBox="0 0 ' + W + ' ' + ROW_H +
        '" preserveAspectRatio="none">' + strandSegments(t, years) + concertMarkers(t, years) + '</svg></button>'
      );
      row.addEventListener("click", () => selectTrace(t.key));
      rows.appendChild(row);
    });
    if (!visible.length) {
      results.textContent = "No artists found. Try another name.";
    } else if (browse) {
      results.textContent = (page * PAGE_SIZE + 1) + "–" + Math.min((page + 1) * PAGE_SIZE, filtered.length) +
        " of " + filtered.length.toLocaleString("en-US") + " artists";
    } else {
      results.textContent = filtered.length + " stories this week";
    }
    pager.hidden = !browse || pages <= 1;
    previous.disabled = page === 0;
    next.disabled = page >= pages - 1;
    pageLabel.textContent = "Page " + (page + 1) + " of " + pages;
    if (visible.length) {
      const remembered = selectedByMode[mode];
      selectTrace(visible.some((t) => t.key === remembered) ? remembered : visible[0].key);
    }
  }
  storiesButton.addEventListener("click", () => { mode = "stories"; page = 0; draw(); });
  moreButton.addEventListener("click", () => { mode = "more"; page = 0; draw(); });
  search.addEventListener("input", () => { page = 0; draw(); });
  previous.addEventListener("click", () => { page--; draw(); if (previous.disabled) next.focus(); });
  next.addEventListener("click", () => { page++; draw(); if (next.disabled) previous.focus(); });

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
  draw();
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
