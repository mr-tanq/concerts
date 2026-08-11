import { buildArchiveView, filterConcerts, artistsOf, actuallySeenArtistsOf, venueKey } from "./archive-stats.js";
import { getGithubConfig, saveGithubConfig, getFile, putFile, testConnection, isConflictError } from "./github-api.js";
import { initMirror, renderMirror, stopPolling as stopMirrorPolling } from "./mirror.js";
import { initIdentity, renderHero, renderExplore as renderIdentityExplore, renderRightNow, openArtistSheet } from "./identity.js";
import { initRealm, renderRealm } from "./realm.js";
import { computeListeningLife, selectEditorialMoments, renderListeningLife, renderEditorialMoments } from "./self-timeline.js";

// ---------- global error visibility ----------
//
// This app is used exclusively on a phone, where the JS console is never
// actually seen. Without this, any uncaught error just fails silently —
// the screen goes blank or stops updating and there's no way to tell why.
// Registered as the very first thing this module does, so it's active
// before any click handler or async chain gets a chance to throw.
let fatalErrors = [];
function showFatalError(text) {
  fatalErrors.push(text);
  document.getElementById("fatal-error-bar")?.remove();
  const bar = document.createElement("div");
  bar.id = "fatal-error-bar";
  bar.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:9999;background:#2a0a0a;color:#ffb4b0;" +
    "font-family:monospace;font-size:11px;line-height:1.5;padding:12px;white-space:pre-wrap;" +
    "word-break:break-word;max-height:45vh;overflow:auto;border-bottom:2px solid #ff5a4d";
  bar.textContent = fatalErrors.map((e, i) => `[${i + 1}] ${e}`).join("\n\n");
  const dismiss = document.createElement("button");
  dismiss.textContent = "Dismiss";
  dismiss.style.cssText =
    "display:block;margin-top:10px;background:#ff5a4d;color:#1a0505;border:none;" +
    "padding:8px 14px;border-radius:4px;font-weight:700;font-family:sans-serif;font-size:12px";
  dismiss.addEventListener("click", () => { fatalErrors = []; bar.remove(); });
  bar.appendChild(dismiss);
  document.body.appendChild(bar);
}
window.addEventListener("error", (e) => {
  showFatalError((e.error?.stack || e.message || String(e)).slice(0, 2000));
});
window.addEventListener("unhandledrejection", (e) => {
  showFatalError(("Unhandled promise: " + (e.reason?.stack || e.reason?.message || String(e.reason))).slice(0, 2000));
});

const TABS = ["mirror", "realm", "concerts", "identity", "archive"];

// Deck state. Swipes are OPTIMISTIC: the card leaves immediately and the
// GitHub commit runs in the background, because waiting ~2s per swipe for
// three sequential API round-trips made the deck feel broken. If a commit
// fails we surface it and push the card back onto the deck.
let deckQueue = [];
let plannedConcerts = [];
let archiveConcerts = [];
let archiveView = null;
let exploreFilter = { mode: "all", value: null };
let dismissedConcerts = [];
let legacyDismissedIds = [];
let pendingWrites = 0;
let syncError = null;

let concertImageBySourceId = new Map();
let concertImageByVenueDate = new Map();
let concertImageByArtist = new Map();
let artistImages = new Map();
let setlists = new Map();

// ---------- tiny helpers ----------

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]
  ));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayMonth(iso) {
  const [, m, d] = String(iso || "").split("-");
  return m ? `${d} ${MONTHS[Number(m) - 1]}` : "";
}
function fullDate(iso) {
  const [y, m, d] = String(iso || "").split("-");
  return y ? `${d} ${MONTHS[Number(m) - 1]} ${y}` : "";
}
function weekdayShort(iso) {
  const dt = new Date(iso + "T00:00:00");
  return dt.toLocaleDateString("en-GB", { weekday: "short" });
}
function yearOf(iso) { return String(iso || "").slice(0, 4); }

function daysUntil(iso) {
  const today = new Date().toISOString().slice(0, 10);
  return Math.round((new Date(iso + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
}
function countdownWord(iso) {
  const d = daysUntil(iso);
  if (d < 0) return "Passed";
  if (d === 0) return "Tonight";
  if (d === 1) return "Tomorrow";
  if (d < 7) return `In ${d} days`;
  if (d < 14) return "Next week";
  if (d < 60) return `In ${Math.round(d / 7)} weeks`;
  return `In ${Math.round(d / 30)} months`;
}

// Spell small numbers out. "Twenty-five years" belongs in a sentence about a
// life; "25 years" belongs in a spreadsheet.
const WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty",
  "twenty-one","twenty-two","twenty-three","twenty-four","twenty-five","twenty-six","twenty-seven",
  "twenty-eight","twenty-nine","thirty"];
function spell(n) { return WORDS[n] || String(n); }
function titleCase(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// ---------- images ----------

function normalizeKey(s) {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

// The image Podiuminfo exposes is the ARTIST's photo, not concert artwork
// (the URL is literally /img/artist/<id>/...). So the artist name is the
// natural key, and any cached concert featuring that artist yields it —
// which is what rescues records saved before the schema carried sourceId.
function imageFor(rec) {
  if (!rec) return null;

  // Deezer's curated 1000px photo must be checked FIRST. rec.image (set
  // directly from the concert's own source page — Podiuminfo's artist
  // thumbnails run around ~100px) used to be checked before this, which
  // meant it permanently won even when a far better Deezer photo existed
  // for the exact same artist — that mismatch between this comment and the
  // actual order was the real cause of "blurry" (upscaled tiny thumbnail)
  // photos on the Tonight/Discover stage.
  const byName = artistImages.get(normalizeKey(rec.artist));
  if (byName) return byName;

  if (rec.image) return rec.image;

  const cached = concertImageByArtist.get(normalizeKey(rec.artist));
  if (cached) return cached;

  let sid = rec.sourceId ? String(rec.sourceId) : null;
  if (!sid) {
    const m = String(rec.id || "").match(/podiuminfo-(\d+)/) ||
              String(rec.recommendationId || "").match(/podiuminfo-(\d+)/);
    if (m) sid = m[1];
  }
  if (sid && concertImageBySourceId.has(sid)) return concertImageBySourceId.get(sid);

  if (rec.venue && rec.date) {
    const hit = concertImageByVenueDate.get(`${normalizeKey(rec.venue)}|${rec.date}`);
    if (hit) return hit;
  }
  return null;
}

// Photos are applied from JS rather than inlined into the markup so a URL
// containing quotes can never break out of a style attribute.
function setPhoto(node, url) {
  if (!node) return false;
  if (!url) { node.classList.add("is-empty"); return false; }
  node.style.backgroundImage = `url("${url.replace(/"/g, "%22")}")`;
  return true;
}

// ---------- staleness shield ----------
//
// GitHub Pages serves data/*.json through a CDN that can keep returning the
// previous version for minutes after a commit, which made freshly dismissed
// concerts reappear on refresh. Filter against history AND a short local
// record of what was just acted on, since the history file can be stale too.

const RECENT_KEY = "lm_recently_handled";
const RECENT_TTL_MS = 30 * 60 * 1000;

function loadRecentlyHandled() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}");
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw).filter(([, t]) => now - t < RECENT_TTL_MS));
  } catch { return {}; }
}
function markRecentlyHandled(id) {
  const map = loadRecentlyHandled();
  map[id] = Date.now();
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(map)); } catch {}
}
function filterStaleRecommendations(concerts, historyData) {
  const excluded = new Set([
    ...(historyData?.dismissedIds || []),
    ...(historyData?.plannedIds || []),
    ...Object.keys(loadRecentlyHandled()),
  ]);
  return concerts.filter((c) => !excluded.has(c.id));
}

// ---------- serialized, conflict-safe repo writes ----------
//
// Swipes are optimistic, so several writes can fire within a second. Running
// them concurrently meant they all read the same file sha, the first PUT won
// and the rest failed. Every mutation goes through one serial queue, and
// each attempt re-reads state and re-applies its change, so a conflict is
// resolved by rebasing rather than overwriting.

let writeChain = Promise.resolve();

function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

async function mutate(paths, applyFn, message, attempts = 4) {
  const config = getGithubConfig();
  if (!config) throw new Error("Not connected to GitHub");

  for (let attempt = 0; ; attempt++) {
    const files = {};
    for (const p of paths) files[p] = await getFile(config, p);

    const jsons = {};
    for (const p of paths) jsons[p] = files[p].json;
    const touched = applyFn(jsons) || paths;

    try {
      for (const p of touched) await putFile(config, p, jsons[p], files[p].sha, message);
      return;
    } catch (err) {
      if (isConflictError(err) && attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ---------- remote writes ----------

function plannedRecordFrom(rec) {
  return {
    id: `planned-${String(rec.id).replace(/^rec-/, "")}`,
    source: rec.source || "podiuminfo",
    sourceId: rec.sourceId ?? null,
    artist: rec.artist,
    lineup: rec.lineup || [],
    supportingArtists: rec.supportingArtists || [],
    date: rec.date,
    time: rec.time || null,
    venue: rec.venue,
    city: rec.city,
    country: rec.country,
    isFestival: rec.isFestival || false,
    image: rec.image || null,
    ticketUrl: rec.ticketUrl || null,
    sourceUrl: rec.sourceUrl || null,
    recommendationId: rec.id,
    planning: { plannedAt: new Date().toISOString(), originalScore: rec.match?.score ?? null },
  };
}

async function planConcertRemote(rec) {
  const RECS = "data/recommendations.json";
  const PLANNED = "data/planned.json";
  const HIST = "data/recommendation-history.json";

  await mutate([RECS, PLANNED, HIST], (f) => {
    const recs = f[RECS], planned = f[PLANNED], history = f[HIST];

    const idx = recs.concerts.findIndex((c) => c.id === rec.id);
    if (idx !== -1) {
      recs.concerts.splice(idx, 1);
      recs.meta.lastUpdated = new Date().toISOString();
    }

    const record = plannedRecordFrom(rec);
    const dup = planned.concerts.some(
      (c) => (c.sourceId && rec.sourceId && String(c.sourceId) === String(rec.sourceId)) ||
             (c.artist === record.artist && c.date === record.date && c.venue === record.venue)
    );
    if (!dup) planned.concerts.push(record);
    planned.meta.lastUpdated = new Date().toISOString();

    if (!history.plannedIds.includes(rec.id)) history.plannedIds.push(rec.id);
  }, `chore: plan ${rec.id} (app)`);
}

async function dismissConcertRemote(rec) {
  const RECS = "data/recommendations.json";
  const HIST = "data/recommendation-history.json";

  await mutate([RECS, HIST], (f) => {
    const recs = f[RECS], history = f[HIST];

    const idx = recs.concerts.findIndex((c) => c.id === rec.id);
    if (idx !== -1) {
      recs.concerts.splice(idx, 1);
      recs.meta.lastUpdated = new Date().toISOString();
    }
    if (!history.dismissedIds.includes(rec.id)) history.dismissedIds.push(rec.id);

    // A full snapshot, not just the id — otherwise a set-aside concert is
    // unreviewable and unrestorable.
    if (!Array.isArray(history.dismissed)) history.dismissed = [];
    if (!history.dismissed.some((d) => d.id === rec.id)) {
      history.dismissed.unshift({ ...rec, dismissedAt: new Date().toISOString() });
    }
  }, `chore: dismiss ${rec.id} (app)`);
}

async function restoreConcertsRemote(recsToRestore, legacyIdsToRestore = []) {
  const RECS = "data/recommendations.json";
  const HIST = "data/recommendation-history.json";
  const restoringIds = new Set([...recsToRestore.map((r) => r.id), ...legacyIdsToRestore]);

  await mutate([RECS, HIST], (f) => {
    const recs = f[RECS], history = f[HIST];

    history.dismissedIds = (history.dismissedIds || []).filter((id) => !restoringIds.has(id));
    history.dismissed = (history.dismissed || []).filter((d) => !restoringIds.has(d.id));

    for (const rec of recsToRestore) {
      if (recs.concerts.some((c) => c.id === rec.id)) continue;
      const { dismissedAt, ...clean } = rec;
      recs.concerts.push(clean);
    }
    recs.concerts.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
    recs.meta.lastUpdated = new Date().toISOString();
  }, `chore: restore ${restoringIds.size} concert(s) (app)`);
}

async function unplanConcertRemote(plannedRec) {
  const RECS = "data/recommendations.json";
  const PLANNED = "data/planned.json";
  const HIST = "data/recommendation-history.json";
  const recId = plannedRec.recommendationId || String(plannedRec.id || "").replace(/^planned-/, "rec-");

  await mutate([RECS, PLANNED, HIST], (f) => {
    const recs = f[RECS], planned = f[PLANNED], history = f[HIST];

    const idx = planned.concerts.findIndex((c) => c.id === plannedRec.id);
    if (idx !== -1) {
      planned.concerts.splice(idx, 1);
      planned.meta.lastUpdated = new Date().toISOString();
    }

    // Drop it from the exclude-list, otherwise discovery keeps filtering it
    // out and it can never come back.
    history.plannedIds = (history.plannedIds || []).filter((id) => id !== recId);

    if (!recs.concerts.some((c) => c.id === recId)) {
      recs.concerts.push({
        id: recId,
        source: plannedRec.source || "podiuminfo",
        sourceId: plannedRec.sourceId ?? null,
        artist: plannedRec.artist,
        lineup: plannedRec.lineup || [],
        supportingArtists: plannedRec.supportingArtists || [],
        matchedArtists: [plannedRec.artist],
        date: plannedRec.date,
        time: plannedRec.time || null,
        venue: plannedRec.venue,
        city: plannedRec.city,
        country: plannedRec.country || "??",
        isFestival: plannedRec.isFestival || false,
        image: plannedRec.image || null,
        ticketUrl: plannedRec.ticketUrl || null,
        sourceApis: plannedRec.sourceApis || ["podiuminfo"],
        sourceUrl: plannedRec.sourceUrl || null,
        match: {
          score: plannedRec.planning?.originalScore ?? 50,
          label: "Strong match",
          matchedBy: "direct",
          reason: `Known artist: ${plannedRec.artist}`,
          matchedArtists: [plannedRec.artist],
        },
        discoveredAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });
      recs.concerts.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
      recs.meta.lastUpdated = new Date().toISOString();
    }
  }, `chore: unplan ${plannedRec.id} (app)`);

  return recId;
}

async function saveConcertNoteRemote(concert, text) {
  const ARCH = "data/archive.json";
  await mutate([ARCH], (f) => {
    const archive = f[ARCH];
    const row = archive.concerts.find((x) => x.id === concert.id);
    if (!row) throw new Error("Concert not found in the archive");
    row.notes = text || null;
    if (archive.meta) archive.meta.lastUpdated = new Date().toISOString();
  }, `chore: note on ${concert.id} (app)`);
}

async function saveSeenArtistsRemote(concert, seenNames) {
  const ARCH = "data/archive.json";
  await mutate([ARCH], (f) => {
    const archive = f[ARCH];
    const row = archive.concerts.find((x) => x.id === concert.id);
    if (!row) throw new Error("Concert not found in the archive");
    row.seenArtists = seenNames;
    if (archive.meta) archive.meta.lastUpdated = new Date().toISOString();
  }, `chore: update who was seen at ${concert.id} (app)`);
}

// For the night the archive simply didn't record everyone who played —
// most often a support act that never made it into the source data.
// Added into lineup (festivals) or supportingArtists (everything else),
// and into seenArtists too: adding someone here already means you
// remember them being there.
async function addLineupArtistRemote(concert, name) {
  const ARCH = "data/archive.json";
  await mutate([ARCH], (f) => {
    const archive = f[ARCH];
    const row = archive.concerts.find((x) => x.id === concert.id);
    if (!row) throw new Error("Concert not found in the archive");
    if (row.isFestival) {
      if (!Array.isArray(row.lineup)) row.lineup = [];
      if (!row.lineup.includes(name)) row.lineup.push(name);
    } else {
      if (!Array.isArray(row.supportingArtists)) row.supportingArtists = [];
      if (!row.supportingArtists.includes(name)) row.supportingArtists.push(name);
    }
    if (Array.isArray(row.seenArtists) && !row.seenArtists.includes(name)) row.seenArtists.push(name);
    if (archive.meta) archive.meta.lastUpdated = new Date().toISOString();
  }, `chore: add ${name} to ${concert.id} (app)`);
}

// ---------- saving indicator ----------

function renderSaving() {
  document.getElementById("saving")?.remove();
  if (pendingWrites === 0 && !syncError) return;
  const node = syncError
    ? el(`<div class="saving bad" id="saving">${esc(syncError)}</div>`)
    : el(`<div class="saving" id="saving">Saving</div>`);
  document.body.appendChild(node);
  if (syncError) setTimeout(() => { syncError = null; renderSaving(); }, 6000);
}

// ==========================================================================
// ARCHIVE — the spine
// ==========================================================================

function renderArchive(archiveData) {
  archiveConcerts = archiveData.concerts || [];
  archiveView = buildArchiveView(archiveConcerts);
  const root = document.getElementById("panel-archive");
  root.innerHTML = "";

  root.appendChild(openingStatement(archiveView));

  const anniversary = anniversaryLine(archiveView) || forgottenMemoryLine();
  if (anniversary) root.appendChild(anniversary);

  root.appendChild(el(`<div id="explore-root"></div>`));
  root.appendChild(el(`<div id="spine-root"></div>`));
  renderExplore();
}

// The archive's headline numbers written as a sentence. Four stat tiles say
// "here is some data"; a sentence says "here is your life".
function openingStatement(view) {
  const { totalConcerts, festivals, venues, cities } = view.overview;
  const firstYear = yearOf(view.milestones.first?.date);
  const lastYear = yearOf(view.milestones.latest?.date);
  const span = firstYear && lastYear ? Number(lastYear) - Number(firstYear) + 1 : 0;
  const firstCity = view.milestones.first?.city;
  const topCity = view.patterns.topCities[0]?.name;

  const journey = firstCity && topCity && firstCity !== topCity
    ? `From ${esc(firstCity)} to ${esc(topCity)}.`
    : firstCity ? `It started in ${esc(firstCity)}.` : "";

  const node = el(`
    <div class="opening">
      <p class="whisper">The Archive</p>
      <p class="lede">
        ${totalConcerts} nights.<br>
        ${span ? `${titleCase(spell(span))} years.<br>` : ""}
        <em>${journey}</em>
      </p>
      <p class="opening-figures">
        <b>${festivals}</b> festivals ·
        <b>${venues}</b> rooms ·
        <b>${cities}</b> cities<br>
        Most often: <b>${esc(view.signature.topArtist?.name ?? "—")}</b>, ${view.signature.topArtist?.count ?? 0} times<br>
        Most familiar room: <b>${esc(view.signature.topVenue?.name ?? "—")}</b>, ${view.signature.topVenue?.count ?? 0} visits<br>
        Busiest year: <b>${esc(view.peakYear?.name ?? "—")}</b>, ${view.peakYear?.count ?? 0} nights
      </p>
    </div>
  `);
  return node;
}

// The single most affecting thing the archive knows: that tonight is an
// anniversary. Given its own line rather than buried under a heading.
function anniversaryLine(view) {
  const hits = view.onThisDay;
  if (!hits.length) return null;
  const c = hits[0];
  const node = el(`
    <div class="anniversary">
      <p class="whisper">On this day</p>
      <p class="anniversary-line">
        ${titleCase(spell(c.yearsAgo))} year${c.yearsAgo === 1 ? "" : "s"} ago tonight —
        ${esc(c.festivalName || c.artist)}<span>, ${esc(c.venue)}</span>
      </p>
    </div>
  `);
  node.addEventListener("click", () => openSheet(c));
  return node;
}

// Most days aren't anniversaries — this is what fills that space instead,
// so the archive resurfaces something every time rather than only on the
// rare exact date. Picked deterministically from the day (stable if you
// reopen the tab, different tomorrow), and weighted toward concerts with
// no notes attached — the ones you genuinely never wrote a word about are
// the ones actually worth being reminded of.
function forgottenMemoryLine() {
  if (!archiveConcerts.length) return null;
  const todaySeed = new Date().toISOString().slice(0, 10);
  const seed = [...todaySeed].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0);

  const undocumented = archiveConcerts.filter((c) => !(c.notes && c.notes.trim()));
  const pool = undocumented.length ? undocumented : archiveConcerts;
  const c = pool[seed % pool.length];

  const yearsAgo = Number(yearOf(new Date().toISOString())) - Number(yearOf(c.date));
  const whenPhrase = yearsAgo > 0 ? `${titleCase(spell(yearsAgo))} year${yearsAgo === 1 ? "" : "s"} ago` : "Earlier this year";

  const node = el(`
    <div class="anniversary">
      <p class="whisper">From the archive</p>
      <p class="anniversary-line">
        ${whenPhrase} —
        ${esc(c.festivalName || c.artist)}<span>, ${esc(c.venue)}</span>
      </p>
    </div>
  `);
  node.addEventListener("click", () => openSheet(c));
  return node;
}

function renderExplore() {
  const host = document.getElementById("explore-root");
  if (!host || !archiveView) return;
  host.innerHTML = "";

  const MODES = [["all","Everything"],["year","By year"],["artist","By artist"],["city","By city"],["venue","By room"]];
  const bar = el(`<div class="explore"><div class="explore-modes"></div></div>`);
  const modes = bar.querySelector(".explore-modes");

  for (const [mode, label] of MODES) {
    const b = el(`<button class="explore-mode ${exploreFilter.mode === mode ? "on" : ""}">${label}</button>`);
    b.addEventListener("click", () => { exploreFilter = { mode, value: null }; renderExplore(); });
    modes.appendChild(b);
  }

  if (exploreFilter.mode !== "all") {
    const values = archiveView.explore[exploreFilter.mode] || [];
    const row = el(`<div class="explore-values"></div>`);
    // A horizontal scroll rather than a wall of wrapped pills: 400 artists
    // should be a drawer you pull through, not a page you fall down.
    for (const { name, count } of values.slice(0, 60)) {
      const v = el(`<button class="explore-value ${exploreFilter.value === name ? "on" : ""}">${esc(name)}<i>${count}</i></button>`);
      v.addEventListener("click", () => {
        exploreFilter = { mode: exploreFilter.mode, value: exploreFilter.value === name ? null : name };
        renderExplore();
      });
      row.appendChild(v);
    }
    bar.appendChild(row);
  }

  host.appendChild(bar);
  renderSpine();
}

function renderSpine() {
  const host = document.getElementById("spine-root");
  if (!host) return;
  host.innerHTML = "";

  const list = filterConcerts(archiveConcerts, exploreFilter)
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  if (exploreFilter.value) {
    host.appendChild(el(`<p class="filter-note">${list.length} night${list.length === 1 ? "" : "s"} · ${esc(exploreFilter.value)}</p>`));
  }

  if (!list.length) {
    host.appendChild(el(`<p class="void">Nothing here.</p>`));
    return;
  }

  const spine = el(`<div class="spine"></div>`);

  // Group by year so the spine reads as chapters. Newest first: the archive
  // is something you walk backwards into.
  let currentYear = null;
  let band = null;
  for (const c of list) {
    const y = yearOf(c.date);
    if (y !== currentYear) {
      currentYear = y;
      const count = list.filter((x) => yearOf(x.date) === y).length;
      band = el(`
        <div class="year-band">
          <div class="year-ghost">${esc(y)}</div>
          <div class="year-mark"><b>${esc(y)}</b>${count} night${count === 1 ? "" : "s"}</div>
        </div>
      `);
      spine.appendChild(band);
    }
    band.appendChild(archiveEntry(c));
  }

  host.appendChild(spine);
}

function archiveEntry(c) {
  const support = (c.supportingArtists || []).filter(Boolean);
  const withLine = support.length
    ? `<div class="entry-with">with ${esc(support.slice(0, 3).join(", "))}${support.length > 3 ? ` +${support.length - 3}` : ""}</div>`
    : "";
  const firstTimeTag = isFirstTimeSeeing(c) ? `<span class="entry-first">First time</span>` : "";

  const node = el(`
    <article class="entry ${c.isFestival ? "is-festival" : ""}">
      <div class="entry-text">
        <div class="entry-date">${weekdayShort(c.date)} · ${dayMonth(c.date)}${firstTimeTag}</div>
        <h3 class="entry-artist">${esc(c.festivalName || c.artist)}</h3>
        ${withLine}
        <div class="entry-place">${esc(c.venue)}<span class="dot">·</span>${esc(c.city)}</div>
      </div>
      <div class="entry-photo"></div>
    </article>
  `);
  setPhoto(node.querySelector(".entry-photo"), imageFor(c));
  node.addEventListener("click", () => openSheet(c));
  return node;
}

// ==========================================================================
// DETAIL — a full page for one night
// ==========================================================================

const ORDINALS = ["first","second","third","fourth","fifth","sixth","seventh","eighth","ninth","tenth",
  "eleventh","twelfth","thirteenth","fourteenth","fifteenth"];

// Every concert in the archive that shares this one's "subject" (its own
// headliner, or its own festival name) — support-slot and festival-lineup
// appearances count too, the same broad matching artistsOf() already uses
// everywhere else. Shared by the memory statement and the spine's
// first-time marker so the two can never disagree with each other.
function concertsForSubject(c) {
  const subject = c.festivalName || c.artist;
  const key = normalizeKey(subject);
  return archiveConcerts
    .filter((x) => actuallySeenArtistsOf(x).some((n) => normalizeKey(n) === key) || normalizeKey(x.festivalName || x.artist) === key)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// Not a fact — a memory. "The third of four times you've seen them" reads
// completely differently from a visit counter, even though it's the exact
// same number underneath.
function timesSeenStatement(c) {
  const subject = c.festivalName || c.artist;
  const all = concertsForSubject(c);
  const total = all.length;
  if (total <= 1) return `The only time you've seen ${esc(subject)} — so far.`;
  const index = all.findIndex((x) => x.id === c.id) + 1;
  const ord = ORDINALS[index - 1] || `${index}th`;
  return `The ${ord} of ${spell(total)} times you've seen ${esc(subject)}.`;
}

// Marks the earliest night with this subject as a discovery, not just
// another row — the spine should feel like walking backward into moments
// that were once new, not a flat list where every night looks equally routine.
function isFirstTimeSeeing(c) {
  const all = concertsForSubject(c);
  return all.length > 0 && all[0].id === c.id;
}

function openSheet(c) {
  const root = document.getElementById("settings-modal-root");
  const photo = imageFor(c);
  const lineup = artistsOf(c);
  const room = venueKey(c);
  const planned = plannedConcerts.find((p) => p.id === c.id) || null;

  root.innerHTML = "";
  const sheet = el(`
    <div class="sheet-root">
      <button class="sheet-close">Close</button>
      <div class="sheet-inner">
        <div class="sheet-photo ${photo ? "" : "is-empty"}"></div>
        <div class="sheet-head">
          <h2 class="sheet-artist">${esc(c.festivalName || c.artist)}</h2>
          <div class="sheet-when">
            ${weekdayShort(c.date)} ${fullDate(c.date)}<br>
            ${esc(c.venue)}, ${esc(c.city)}
          </div>
          <p class="lede sheet-memory-line">${timesSeenStatement(c)}</p>
        </div>

        <dl class="facts">
          <div class="fact"><dt>Billing</dt><dd>${c.isFestival ? "Festival" : "Own show"}</dd></div>
          ${room && room !== c.venue ? `<div class="fact"><dt>Part of</dt><dd>${esc(room)}</dd></div>` : ""}
          ${c.country ? `<div class="fact"><dt>Country</dt><dd>${esc(c.country)}</dd></div>` : ""}
        </dl>

        <div class="sheet-section">
          <p class="whisper">Who did you actually see?</p>
          <div id="sheet-lineup"></div>
          <p class="status" id="lineup-status"></p>
        </div>

        <div class="sheet-section">
          <p class="whisper">Note to self</p>
          <div id="sheet-note"></div>
        </div>

        <div id="sheet-setlist"></div>

        ${planned ? `
          <div class="sheet-section">
            <p class="whisper">Change of plan</p>
            <div class="act-row" style="padding-left:0;padding-right:0">
              ${planned.ticketUrl ? `<button class="plain-act" id="sheet-tickets">Tickets</button>` : ""}
              <button class="plain-act" id="sheet-unplan">Not going after all</button>
            </div>
          </div>` : ""}
      </div>
    </div>
  `);
  root.appendChild(sheet);

  // Unplan is reachable from any planned concert, not just whichever one
  // happens to be next — a mistake buried three deep still has to be undoable.
  if (planned) {
    sheet.querySelector("#sheet-tickets")?.addEventListener("click", () => window.open(planned.ticketUrl, "_blank"));
    const un = sheet.querySelector("#sheet-unplan");
    un.addEventListener("click", async () => {
      if (!getGithubConfig()) { openSettings(); return; }
      un.disabled = true; un.textContent = "Removing";
      pendingWrites++; renderSaving();
      try {
        const recId = await enqueue(() => unplanConcertRemote(planned));
        plannedConcerts = plannedConcerts.filter((x) => x.id !== planned.id);
        if (!deckQueue.some((d) => d.id === recId)) {
          deckQueue.push({
            ...planned, id: recId,
            match: { score: planned.planning?.originalScore ?? 50, label: "Strong match",
                     reason: `Known artist: ${planned.artist}`, matchedArtists: [planned.artist] },
          });
        }
        root.innerHTML = "";
        renderConcertsShell("going");
      } catch (err) {
        console.error(err);
        syncError = err.message;
        un.disabled = false; un.textContent = "Not going after all";
        renderSaving();
      } finally { pendingWrites--; renderSaving(); }
    });
  }

  setPhoto(sheet.querySelector(".sheet-photo"), photo);
  sheet.querySelector(".sheet-close").addEventListener("click", () => { root.innerHTML = ""; });

  renderNote(sheet.querySelector("#sheet-note"), c);
  renderSetlist(sheet.querySelector("#sheet-setlist"), c);
  renderLineupPicker(sheet.querySelector("#sheet-lineup"), sheet.querySelector("#lineup-status"), c, lineup);
}

// Lets the person mark exactly which names on the bill they actually
// watched — a festival lineup or a support slot is a claim about who
// PLAYED, not about who this person SAW, and those two things have been
// quietly conflated everywhere the app counts "times seen" until now.
// Local toggle state, explicit Save — same pattern as the note editor, so
// ten taps cost one write instead of ten.
function renderLineupPicker(host, status, c, lineup) {
  host.innerHTML = "";
  const seenNow = new Set(actuallySeenArtistsOf(c).map(normalizeKey));
  const pending = new Set(seenNow);

  const list = el(`<div></div>`);
  lineup.forEach((name) => {
    const key = normalizeKey(name);
    const row = el(`
      <div class="lineup-row ${pending.has(key) ? "is-seen" : ""}">
        <span class="lineup-name">${esc(name)}</span>
        <span class="lineup-state">${pending.has(key) ? "Seen" : "Missed"}</span>
      </div>
    `);
    row.addEventListener("click", () => {
      if (pending.has(key)) pending.delete(key); else pending.add(key);
      row.classList.toggle("is-seen", pending.has(key));
      row.querySelector(".lineup-state").textContent = pending.has(key) ? "Seen" : "Missed";
    });
    list.appendChild(row);
  });
  host.appendChild(list);

  const saveRow = el(`<div class="act-row" style="padding-left:0;padding-right:0"><button class="plain-act" id="lineup-save">Save</button></div>`);
  host.appendChild(saveRow);
  const saveBtn = saveRow.querySelector("#lineup-save");

  saveBtn.addEventListener("click", async () => {
    if (!getGithubConfig()) { openSettings(); return; }
    saveBtn.disabled = true; saveBtn.textContent = "Saving";
    const namesToSave = lineup.filter((n) => pending.has(normalizeKey(n)));
    try {
      await enqueue(() => saveSeenArtistsRemote(c, namesToSave));
      c.seenArtists = namesToSave;
      const local = archiveConcerts.find((x) => x.id === c.id);
      if (local) local.seenArtists = namesToSave;
      status.textContent = "Saved.";
      status.className = "status";
    } catch (err) {
      console.error(err);
      status.textContent = err.message;
      status.className = "status bad";
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = "Save";
    }
  });

  // The source data missed someone — most often a support act that was
  // never in the crawled lineup. Kept as small and out of the way as
  // possible at rest: a single quiet line, not a form sitting open.
  const addTrigger = el(`<button class="lineup-add-trigger">+ Someone missing?</button>`);
  host.appendChild(addTrigger);

  addTrigger.addEventListener("click", () => {
    const addRow = el(`
      <div class="lineup-add">
        <input type="text" class="lineup-add-input" placeholder="Who else played?" />
        <button class="plain-act" id="lineup-add-btn">Add</button>
      </div>
    `);
    addTrigger.replaceWith(addRow);
    const addInput = addRow.querySelector(".lineup-add-input");
    const addBtn = addRow.querySelector("#lineup-add-btn");
    addInput.focus();

    async function addArtist() {
      const name = addInput.value.trim();
      if (!name) return;
      if (lineup.some((n) => normalizeKey(n) === normalizeKey(name))) {
        status.textContent = "Already on the list.";
        status.className = "status bad";
        return;
      }
      if (!getGithubConfig()) { openSettings(); return; }
      addBtn.disabled = true; addBtn.textContent = "Adding";
      try {
        await enqueue(() => addLineupArtistRemote(c, name));
        if (c.isFestival) {
          if (!Array.isArray(c.lineup)) c.lineup = [];
          c.lineup.push(name);
        } else {
          if (!Array.isArray(c.supportingArtists)) c.supportingArtists = [];
          c.supportingArtists.push(name);
        }
        if (Array.isArray(c.seenArtists) && !c.seenArtists.includes(name)) c.seenArtists.push(name);
        const local = archiveConcerts.find((x) => x.id === c.id);
        if (local) {
          local.lineup = c.lineup;
          local.supportingArtists = c.supportingArtists;
          local.seenArtists = c.seenArtists;
        }
        status.textContent = `Added ${name}.`;
        status.className = "status";
        renderLineupPicker(host, status, c, artistsOf(c));
      } catch (err) {
        console.error(err);
        status.textContent = err.message;
        status.className = "status bad";
        addBtn.disabled = false; addBtn.textContent = "Add";
      }
    }
    addBtn.addEventListener("click", addArtist);
    addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addArtist(); } });
  });
              }
