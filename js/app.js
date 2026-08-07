import { buildArchiveView, filterConcerts, artistsOf, venueKey } from "./archive-stats.js";
import { getGithubConfig, saveGithubConfig, getFile, putFile, testConnection, isConflictError } from "./github-api.js";
import { initMirror, renderMirror, stopPolling as stopMirrorPolling } from "./mirror.js";
import { initIdentity, renderIdentity } from "./identity.js";
import { initRealm, renderRealm } from "./realm.js";

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
    .filter((x) => artistsOf(x).some((n) => normalizeKey(n) === key) || normalizeKey(x.festivalName || x.artist) === key)
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
  // Everyone except the name already in the title above. For a festival that
  // title is the festival itself, so this is the real bill; for a concert
  // it's the headliner, so this is the support.
  const support = lineup.filter((n) => n !== c.artist && n !== c.festivalName);
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

        ${support.length ? `
          <div class="sheet-section">
            <p class="whisper">${c.isFestival ? "Who played" : "Support"}</p>
            <p class="names">${esc(support.join(", "))}</p>
          </div>` : ""}

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
}

function renderNote(host, c) {
  host.innerHTML = "";
  const has = !!(c.notes && c.notes.trim());

  const view = el(`
    <div>
      <p class="note-body ${has ? "" : "is-empty"}">${has ? esc(c.notes) : "Nothing written down."}</p>
      <button class="plain-act">${has ? "Edit" : "Write something"}</button>
    </div>
  `);
  view.querySelector(".plain-act").addEventListener("click", () => {
    const editor = el(`
      <div>
        <textarea class="note-field" rows="3" placeholder="What do you remember?">${esc(c.notes || "")}</textarea>
        <p class="status" id="note-status"></p>
        <div style="display:flex;gap:26px;margin-top:6px">
          <button class="plain-act" id="note-save">Save</button>
          <button class="plain-act" id="note-cancel">Cancel</button>
        </div>
      </div>
    `);
    host.innerHTML = "";
    host.appendChild(editor);

    const status = editor.querySelector("#note-status");
    editor.querySelector("#note-cancel").addEventListener("click", () => renderNote(host, c));
    editor.querySelector("#note-save").addEventListener("click", async (e) => {
      if (!getGithubConfig()) { openSettings(); return; }
      const text = editor.querySelector(".note-field").value.trim();
      e.target.disabled = true;
      e.target.textContent = "Saving";
      try {
        await enqueue(() => saveConcertNoteRemote(c, text));
        c.notes = text;
        const local = archiveConcerts.find((x) => x.id === c.id);
        if (local) local.notes = text;
        renderNote(host, c);
      } catch (err) {
        console.error(err);
        status.textContent = err.message;
        status.className = "status bad";
        e.target.disabled = false;
        e.target.textContent = "Save";
      }
    });
  });
  host.appendChild(view);
                                   }
// Only rendered when a setlist was actually matched. An empty "Setlist"
// heading on every concert would imply data is missing rather than simply
// not existing — most small shows are never submitted to setlist.fm.
function renderSetlist(host, c) {
  if (!host) return;
  const entry = setlists.get(c.id);
  if (!entry || !entry.sets?.length) return;

  const total = entry.songCount || entry.sets.reduce((n, s) => n + s.songs.length, 0);
  const wrap = el(`
    <div class="sheet-section">
      <p class="whisper">What they played · ${total} songs</p>
    </div>
  `);

  for (const set of entry.sets) {
    const block = el(`<div class="setlist-block"></div>`);
    if (entry.sets.length > 1 || /encore/i.test(set.name)) {
      block.appendChild(el(`<div class="setlist-name">${esc(set.name)}</div>`));
    }
    const ol = el(`<ol class="setlist-songs"></ol>`);
    for (const song of set.songs) ol.appendChild(el(`<li>${esc(song)}</li>`));
    block.appendChild(ol);
    wrap.appendChild(block);
  }

  if (entry.sourceUrl) {
    const link = el(`<button class="plain-act">Source: setlist.fm</button>`);
    link.addEventListener("click", () => window.open(entry.sourceUrl, "_blank"));
    wrap.appendChild(link);
  }
  host.appendChild(wrap);
}

// ==========================================================================
// TONIGHT — stage, upcoming, set aside
// ==========================================================================

function renderConcerts(recsData, plannedData, historyData) {
  deckQueue = filterStaleRecommendations(recsData.concerts || [], historyData);
  plannedConcerts = [...(plannedData.concerts || [])];
  dismissedConcerts = [...(historyData?.dismissed || [])];

  const snapshotIds = new Set(dismissedConcerts.map((d) => d.id));
  legacyDismissedIds = (historyData?.dismissedIds || []).filter((id) => !snapshotIds.has(id));

  renderConcertsShell();
}

function renderConcertsShell(view = "stage") {
  const root = document.getElementById("panel-concerts");
  root.innerHTML = "";

  const aside = dismissedConcerts.length + legacyDismissedIds.length;
  const bar = el(`
    <div class="switch">
      <button data-v="stage" class="${view === "stage" ? "on" : ""}">Deciding<i>${deckQueue.length}</i></button>
      <button data-v="going" class="${view === "going" ? "on" : ""}">Going<i>${plannedConcerts.length}</i></button>
      <button data-v="aside" class="${view === "aside" ? "on" : ""}">Set aside<i>${aside}</i></button>
    </div>
  `);
  root.appendChild(bar);

  const body = el(`<div></div>`);
  root.appendChild(body);

  bar.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => renderConcertsShell(b.dataset.v))
  );

  if (view === "stage") renderStage(body);
  else if (view === "going") renderUpcoming(body);
  else renderAside(body);
}

function renderStage(body) {
  body.innerHTML = "";
  if (deckQueue.length === 0) { body.appendChild(caughtUp()); return; }
  body.appendChild(stageCard(deckQueue[0]));
  body.appendChild(el(`<p class="remaining">${deckQueue.length} left</p>`));
}

function stageCard(c) {
  const support = (c.supportingArtists || []).filter(Boolean);
  const time = c.time ? ` · ${esc(c.time)}` : "";

  const stage = el(`
    <div class="stage">
      <div class="stage-photo"></div>
      <div class="stage-veil"></div>
      <div class="verdict yes">Going</div>
      <div class="verdict no">Not this one</div>
      <div class="stage-score"><b>${esc(c.match.score)}</b>${esc(c.match.label)}</div>
      <div class="stage-copy">
        <div class="stage-when">${weekdayShort(c.date)} ${dayMonth(c.date)} ${yearOf(c.date)}${time} · ${esc(c.city)}</div>
        <h2 class="stage-artist">${esc(c.artist)}</h2>
        ${support.length ? `<div class="stage-with">with ${esc(support.slice(0, 3).join(", "))}</div>` : ""}
        <div class="stage-why">${esc(c.venue)}${c.match.matchedBy === "similar" ? ` — ${esc(c.match.reason)}` : ""}</div>
      </div>
    </div>
  `);
  setPhoto(stage.querySelector(".stage-photo"), imageFor(c));

  const yes = stage.querySelector(".verdict.yes");
  const no = stage.querySelector(".verdict.no");

  let dragging = false, startX = 0, startY = 0, dx = 0, locked = null;
  const threshold = 100;

  const hint = (x) => {
    yes.style.opacity = x > 20 ? String(Math.min(x / threshold, 1)) : "0";
    no.style.opacity = x < -20 ? String(Math.min(-x / threshold, 1)) : "0";
  };

  stage.addEventListener("pointerdown", (e) => {
    dragging = true; locked = null;
    startX = e.clientX; startY = e.clientY;
    stage.style.transition = "none";
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    // Decide once whether this is a horizontal swipe or a vertical scroll,
    // so swiping never fights the page.
    if (locked === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      locked = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    }
    if (locked !== "x") return;
    dx = mx;
    stage.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    hint(dx);
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    stage.style.transition = "transform 0.4s var(--ease), opacity 0.4s var(--ease)";
    if (dx > threshold) commit("plan");
    else if (dx < -threshold) commit("dismiss");
    else { stage.style.transform = ""; hint(0); }
    dx = 0;
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);

  // Optimistic: advance immediately, persist in the background.
  function commit(action) {
    if (!getGithubConfig()) { stage.style.transform = ""; hint(0); openSettings(); return; }

    const fly = action === "plan" ? 700 : -700;
    stage.style.transform = `translateX(${fly}px) rotate(${fly / 40}deg)`;
    stage.style.opacity = "0";

    deckQueue.shift();
    markRecentlyHandled(c.id);
    if (action === "plan") plannedConcerts.push(plannedRecordFrom(c));
    else dismissedConcerts.unshift({ ...c, dismissedAt: new Date().toISOString() });

    pendingWrites++; renderSaving();

    enqueue(() => (action === "plan" ? planConcertRemote(c) : dismissConcertRemote(c)))
      .catch((err) => {
        console.error(err);
        syncError = `Couldn't save ${c.artist}`;
        // Undo the optimistic change so the UI can't drift from the repo.
        deckQueue.push(c);
        if (action === "plan") {
          const i = plannedConcerts.findIndex((p) => p.recommendationId === c.id);
          if (i !== -1) plannedConcerts.splice(i, 1);
        } else {
          const i = dismissedConcerts.findIndex((d) => d.id === c.id);
          if (i !== -1) dismissedConcerts.splice(i, 1);
        }
        renderConcertsShell("stage");
      })
      .finally(() => { pendingWrites--; renderSaving(); });

    setTimeout(() => renderConcertsShell("stage"), 240);
  }

  const acts = el(`
    <div class="stage-acts">
      <button class="act act-no">Pass</button>
      <button class="act act-mid">${c.ticketUrl ? "Tickets" : "Later"}</button>
      <button class="act act-yes">I'm going</button>
    </div>
  `);
  acts.querySelector(".act-no").addEventListener("click", () => commit("dismiss"));
  acts.querySelector(".act-yes").addEventListener("click", () => commit("plan"));
  acts.querySelector(".act-mid").addEventListener("click", () => {
    if (c.ticketUrl) { window.open(c.ticketUrl, "_blank"); return; }
    deckQueue.push(deckQueue.shift());
    renderConcertsShell("stage");
  });

  const wrap = el(`<div></div>`);
  wrap.appendChild(stage);
  wrap.appendChild(acts);
  return wrap;
}

// An empty deck is the normal state most days, so it shouldn't read as a
// dead end. Show what's genuinely next instead.
function caughtUp() {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = plannedConcerts
    .filter((c) => c.date && c.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  const wrap = el(`<div class="caughtup"></div>`);

  if (upcoming.length) {
    const next = upcoming[0];
    wrap.appendChild(el(`
      <p class="whisper">Nothing left to decide</p>
      <p class="lede">Next you'll be standing in front of<br><em>${esc(next.artist)}</em>.</p>
    `));
    wrap.appendChild(upcomingHero(next));
  } else {
    wrap.appendChild(el(`
      <p class="whisper">Nothing left to decide</p>
      <p class="lede">Quiet for now.</p>
      <p class="footnote">New suggestions arrive when the discovery job next runs.</p>
    `));
  }

  const aside = dismissedConcerts.length + legacyDismissedIds.length;
  if (aside) {
    const row = el(`<div class="act-row"><button class="plain-act">Revisit ${aside} set aside</button></div>`);
    row.querySelector("button").addEventListener("click", () => renderConcertsShell("aside"));
    wrap.appendChild(row);
  }
  return wrap;
}

function upcomingHero(c) {
  const support = (c.supportingArtists || []).filter(Boolean);
  const node = el(`
    <div class="upcoming-hero">
      <div class="upcoming-photo"></div>
      <div class="countdown">${countdownWord(c.date)}</div>
      <h3 class="entry-artist">${esc(c.artist)}</h3>
      ${support.length ? `<div class="entry-with">with ${esc(support.slice(0, 3).join(", "))}</div>` : ""}
      <div class="entry-place">${esc(c.venue)}<span class="dot">·</span>${esc(c.city)}<span class="dot">·</span>${fullDate(c.date)}</div>
      <div class="act-row" style="padding-left:0;padding-right:0">
        ${c.ticketUrl ? `<button class="plain-act" data-a="tickets">Tickets</button>` : ""}
        <button class="plain-act" data-a="unplan">Not going after all</button>
      </div>
    </div>
  `);
  setPhoto(node.querySelector(".upcoming-photo"), imageFor(c));

  node.querySelector('[data-a="tickets"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    window.open(c.ticketUrl, "_blank");
  });

  // Guarded: a missing node here used to take the whole render down with it,
  // which is a poor trade for one optional button.
  const un = node.querySelector('[data-a="unplan"]');
  un?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!getGithubConfig()) { openSettings(); return; }
    un.disabled = true; un.textContent = "Removing";
    pendingWrites++; renderSaving();
    try {
      const recId = await enqueue(() => unplanConcertRemote(c));
      plannedConcerts = plannedConcerts.filter((p) => p.id !== c.id);
      if (!deckQueue.some((d) => d.id === recId)) {
        deckQueue.push({
          ...c, id: recId,
          match: { score: c.planning?.originalScore ?? 50, label: "Strong match",
                   reason: `Known artist: ${c.artist}`, matchedArtists: [c.artist] },
        });
      }
      renderConcertsShell("going");
    } catch (err) {
      console.error(err);
      syncError = err.message;
      un.disabled = false; un.textContent = "Not going after all";
      renderSaving();
    } finally { pendingWrites--; renderSaving(); }
  });

  return node;
}

function renderUpcoming(body) {
  body.innerHTML = "";
  const today = new Date().toISOString().slice(0, 10);
  const sorted = [...plannedConcerts].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const upcoming = sorted.filter((c) => c.date >= today);
  const past = sorted.filter((c) => c.date < today);

  if (!sorted.length) {
    body.appendChild(el(`<p class="void">Nothing planned. Swipe right on something.</p>`));
    return;
  }

  // The next concert gets the whole stage; the rest are a quiet index.
  // A flat list of equal cards hides the only thing that matters — what's soon.
  if (upcoming.length) {
    body.appendChild(el(`<div style="padding:0 var(--gutter)"><p class="whisper">Next</p></div>`));
    body.appendChild(upcomingHero(upcoming[0]));
  }

  const rest = [...upcoming.slice(1), ...past];
  if (rest.length) {
    const list = el(`<div class="upcoming-list"><div style="padding:0 var(--gutter) 8px"><p class="whisper">After that</p></div></div>`);
    for (const c of rest) {
      const row = el(`
        <div class="upcoming-row">
          <div class="when">${c.date < today ? "Passed" : countdownWord(c.date)}</div>
          <div class="who">
            <b>${esc(c.artist)}</b>
            <span>${esc(c.venue)} · ${esc(c.city)} · ${fullDate(c.date)}</span>
          </div>
        </div>
      `);
      row.addEventListener("click", () => openSheet(c));
      list.appendChild(row);
    }
    body.appendChild(list);
  }
}

function renderAside(body) {
  body.innerHTML = "";
  const total = dismissedConcerts.length + legacyDismissedIds.length;
  if (!total) {
    body.appendChild(el(`<p class="void">Nothing set aside.</p>`));
    return;
  }

  const head = el(`
    <div style="padding:0 var(--gutter)">
      <p class="lede">${total} you passed on.</p>
      <p class="footnote">Nothing here is deleted. Bring any of them back.</p>
      <div class="act-row" style="padding-left:0;padding-right:0">
        <button class="plain-act" id="restore-all">Bring back all ${total}</button>
      </div>
    </div>
  `);
  head.querySelector("#restore-all").addEventListener("click", async (e) => {
    if (!confirm(`Bring back all ${total}?`)) return;
    e.target.disabled = true; e.target.textContent = "Restoring";
    await doRestore([...dismissedConcerts], [...legacyDismissedIds]);
  });
  body.appendChild(head);

  const list = el(`<div style="margin-top:34px"></div>`);
  for (const rec of dismissedConcerts) {
    const row = el(`
      <div class="aside-row">
        <div class="entry-photo"></div>
        <div class="who">
          <b>${esc(rec.artist)}</b>
          <span>${esc(rec.venue)} · ${esc(rec.city)} · ${fullDate(rec.date)}</span>
        </div>
        <button class="plain-act">Back</button>
      </div>
    `);
    setPhoto(row.querySelector(".entry-photo"), imageFor(rec));
    const btn = row.querySelector("button");
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "…";
      await doRestore([rec], []);
    });
    list.appendChild(row);
  }

  if (legacyDismissedIds.length) {
    list.appendChild(el(`
      <div style="padding:34px var(--gutter) 0">
        <p class="whisper">Passed on before details were kept</p>
        <p class="footnote">Only ids were stored then, so there's nothing to show. Restoring brings them back on the next discovery run.</p>
      </div>
    `));
    for (const id of legacyDismissedIds) {
      const pretty = id.replace(/^rec-(podiuminfo-)?/, "").replace(/-/g, " ");
      const row = el(`
        <div class="aside-row">
          <div class="who"><span>${esc(pretty)}</span></div>
          <button class="plain-act">Back</button>
        </div>
      `);
      const btn = row.querySelector("button");
      btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = "…";
        await doRestore([], [id]);
      });
      list.appendChild(row);
    }
  }
  body.appendChild(list);
}

async function doRestore(recs, legacyIds) {
  pendingWrites++; renderSaving();
  try {
    await enqueue(() => restoreConcertsRemote(recs, legacyIds));
    const ids = new Set([...recs.map((r) => r.id), ...legacyIds]);
    dismissedConcerts = dismissedConcerts.filter((d) => !ids.has(d.id));
    legacyDismissedIds = legacyDismissedIds.filter((id) => !ids.has(id));
    for (const r of recs) {
      const { dismissedAt, ...clean } = r;
      deckQueue.push(clean);
    }
    deckQueue.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
    renderConcertsShell("aside");
  } catch (err) {
    console.error(err);
    syncError = err.message;
    renderConcertsShell("aside");
  } finally { pendingWrites--; renderSaving(); }
}

// ==========================================================================
// PAST-CONCERT RECONCILIATION
// ==========================================================================
//
// A planned date passing is only a prompt to ask, never proof of attendance —
// nothing is archived without an explicit yes. Both answers remove it from
// the going list; only yes writes to the Archive, and the Archive write
// happens FIRST so a failure mid-way leaves the concert safely planned
// rather than losing it entirely.

function archiveRecordFrom(p) {
  return {
    id: `archived-${String(p.id || "").replace(/^planned-/, "")}` || `archived-${Date.now()}`,
    artist: p.artist,
    supportingArtists: p.supportingArtists || [],
    date: p.date,
    venue: p.venue,
    venueFamily: p.venueFamily || p.venue,
    city: p.city,
    country: p.country || null,
    isFestival: p.isFestival || false,
    festivalName: p.festivalName || null,
    image: p.image || imageFor(p) || null,
    urls: [p.sourceUrl, p.ticketUrl].filter(Boolean),
    genreHints: p.genreHints || [],
    notes: null,
    rating: null,
    lineup: p.lineup || [],
    source: p.source || "podiuminfo",
    sourceId: p.sourceId ?? null,
    importedFromPlannedId: p.id || null,
    addedAt: new Date().toISOString(),
  };
}

async function attendedConcertRemote(plannedRec) {
  const ARCH = "data/archive.json";
  const PLANNED = "data/planned.json";
  await mutate([ARCH, PLANNED], (f) => {
    const archive = f[ARCH], planned = f[PLANNED];
    const rec = archiveRecordFrom(plannedRec);

    const dup = archive.concerts.some(
      (c) => (c.sourceId && rec.sourceId && String(c.sourceId) === String(rec.sourceId)) ||
             (c.artist === rec.artist && c.date === rec.date && c.venue === rec.venue)
    );
    if (!dup) archive.concerts.push(rec);
    archive.concerts.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (archive.meta) {
      archive.meta.totalConcerts = archive.concerts.length;
      archive.meta.lastUpdated = new Date().toISOString();
    }

    const i = planned.concerts.findIndex((c) => c.id === plannedRec.id);
    if (i !== -1) {
      planned.concerts.splice(i, 1);
      planned.meta.lastUpdated = new Date().toISOString();
    }
  }, `chore: archive attended ${plannedRec.id} (app)`);
}

async function notAttendedConcertRemote(plannedRec) {
  const PLANNED = "data/planned.json";
  const HIST = "data/recommendation-history.json";
  await mutate([PLANNED, HIST], (f) => {
    const planned = f[PLANNED], history = f[HIST];

    const i = planned.concerts.findIndex((c) => c.id === plannedRec.id);
    if (i !== -1) {
      planned.concerts.splice(i, 1);
      planned.meta.lastUpdated = new Date().toISOString();
    }

    if (!Array.isArray(history.notAttendedIds)) history.notAttendedIds = [];
    if (!history.notAttendedIds.includes(plannedRec.id)) history.notAttendedIds.push(plannedRec.id);

    const recId = plannedRec.recommendationId || String(plannedRec.id || "").replace(/^planned-/, "rec-");
    history.plannedIds = (history.plannedIds || []).filter((id) => id !== recId);
    if (!Array.isArray(history.dismissedIds)) history.dismissedIds = [];
    if (!history.dismissedIds.includes(recId)) history.dismissedIds.push(recId);
  }, `chore: mark not attended ${plannedRec.id} (app)`);
}

function pastPlannedConcerts(historyData) {
  const today = new Date().toISOString().slice(0, 10);
  const settled = new Set(historyData?.notAttendedIds || []);
  return plannedConcerts
    .filter((c) => c.date && c.date < today && !settled.has(c.id))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function askAboutPast(queue) {
  if (!queue.length) return;
  const root = document.getElementById("settings-modal-root");
  const rec = queue[0];
  const lineup = (rec.lineup?.length ? rec.lineup : [rec.artist, ...(rec.supportingArtists || [])]).filter(Boolean);

  root.innerHTML = "";
  const veil = el(`
    <div class="veil">
      <div class="panel">
        <p class="whisper">${queue.length > 1 ? `${queue.length} nights to confirm` : "One night to confirm"}</p>
        <p class="lede">Were you there?</p>
        <div class="prompt-photo"></div>
        <p class="lede" style="font-size:24px;margin-top:20px">${esc(rec.artist)}</p>
        <p class="footnote" style="margin-top:8px">${weekdayShort(rec.date)} ${fullDate(rec.date)} · ${esc(rec.venue)}, ${esc(rec.city)}</p>
        ${lineup.length > 1 ? `<p class="prompt-lineup">${esc(lineup.join(" · "))}</p>` : ""}
        <p class="status" id="prompt-status"></p>
        <div class="act-row" style="padding-left:0;padding-right:0;gap:28px">
          <button class="plain-act" id="p-yes">Yes, I was</button>
          <button class="plain-act" id="p-no">No, I missed it</button>
          <button class="plain-act" id="p-later">Later</button>
        </div>
      </div>
    </div>
  `);
  root.appendChild(veil);
  setPhoto(veil.querySelector(".prompt-photo"), imageFor(rec));

  const status = veil.querySelector("#prompt-status");
  const yes = veil.querySelector("#p-yes");
  const no = veil.querySelector("#p-no");

  const next = () => { root.innerHTML = ""; askAboutPast(queue.slice(1)); };

  async function answer(went) {
    yes.disabled = no.disabled = true;
    status.textContent = went ? "Adding to the archive…" : "Removing…";
    status.className = "status";
    try {
      await enqueue(() => (went ? attendedConcertRemote(rec) : notAttendedConcertRemote(rec)));
      plannedConcerts = plannedConcerts.filter((c) => c.id !== rec.id);
      renderConcertsShell("going");
      next();
    } catch (err) {
      console.error(err);
      // Left planned on purpose — better a repeated question than a lost night.
      status.textContent = `${err.message}. Still in your list, nothing lost.`;
      status.className = "status bad";
      yes.disabled = no.disabled = false;
    }
  }

  yes.addEventListener("click", () => answer(true));
  no.addEventListener("click", () => answer(false));
  veil.querySelector("#p-later").addEventListener("click", next);
}

// ==========================================================================
// SETTINGS
// ==========================================================================

function openSettings() {
  const existing = getGithubConfig() || { owner: "", repo: "", token: "" };
  const root = document.getElementById("settings-modal-root");
  root.innerHTML = "";

  const veil = el(`
    <div class="veil">
      <div class="panel">
        <p class="whisper">Connection</p>
        <p class="lede">Where this diary lives.</p>
        <p class="footnote">
          A fine-grained token from github.com/settings/tokens?type=beta, scoped to
          this repository only, with Contents: read and write. It is kept in this
          browser and nowhere else.
        </p>
        ${storageIsPersistent() ? "" : `<p class="status bad">This browser isn't keeping local storage — private windows clear it on close, which is why the token keeps disappearing.</p>`}
        <div class="field"><label>Owner</label><input id="in-owner" type="text" placeholder="mr-tanq" value="${esc(existing.owner)}" /></div>
        <div class="field"><label>Repository</label><input id="in-repo" type="text" placeholder="concerts" value="${esc(existing.repo)}" /></div>
        <div class="field"><label>Token</label><input id="in-token" type="password" placeholder="github_pat_…" value="${esc(existing.token)}" /></div>
        <p class="status" id="set-status"></p>
        <div class="act-row" style="padding-left:0;padding-right:0;gap:28px">
          <button class="plain-act" id="set-save">Connect</button>
          <button class="plain-act" id="set-close">Close</button>
        </div>
      </div>
    </div>
  `);
  root.appendChild(veil);

  const status = veil.querySelector("#set-status");
  veil.querySelector("#set-close").addEventListener("click", () => { root.innerHTML = ""; });
  veil.addEventListener("click", (e) => { if (e.target === veil) root.innerHTML = ""; });

  veil.querySelector("#set-save").addEventListener("click", async (e) => {
    const owner = veil.querySelector("#in-owner").value.trim();
    const repo = veil.querySelector("#in-repo").value.trim();
    const token = veil.querySelector("#in-token").value.trim();
    if (!owner || !repo || !token) {
      status.textContent = "All three are needed.";
      status.className = "status bad";
      return;
    }
    e.target.disabled = true; e.target.textContent = "Checking";
    status.textContent = ""; status.className = "status";
    try {
      await testConnection({ owner, repo, token });
      saveGithubConfig({ owner, repo, token });
      markConnected();
      status.innerHTML = `Connected. <a href="#" id="lnk">Copy a setup link</a> to restore this instantly later.`;
      veil.querySelector("#lnk").addEventListener("click", async (ev) => {
        ev.preventDefault();
        const url = `${location.origin}${location.pathname}?gh=${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${token}`;
        try { await navigator.clipboard.writeText(url); ev.target.textContent = "Copied — bookmark it"; }
        catch { prompt("Copy this link:", url); }
      });
    } catch (err) {
      status.textContent = err.message;
      status.className = "status bad";
    } finally {
      e.target.disabled = false; e.target.textContent = "Connect";
    }
  });
}

function markConnected() {
  document.getElementById("settings-dot")?.classList.toggle("live", !!getGithubConfig());
}

// Config can arrive in the URL once — ?gh=owner/repo/token — then it's saved
// locally and stripped from the address bar, so one bookmark sets the app up
// without retyping. It is deliberately never baked into the source: this repo
// is public, so a committed token would be readable by anyone and GitHub's
// secret scanning would revoke it within hours.
function adoptConfigFromUrl() {
  const params = new URLSearchParams(location.search);
  const gh = params.get("gh");
  if (!gh) return;
  const [owner, repo, ...rest] = gh.split("/");
  const token = rest.join("/");
  if (owner && repo && token) saveGithubConfig({ owner, repo, token });
  params.delete("gh");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
}

function storageIsPersistent() {
  try {
    localStorage.setItem("__lm_probe", "1");
    localStorage.removeItem("__lm_probe");
    return true;
  } catch { return false; }
}

// ==========================================================================
// BOOT
// ==========================================================================

function setActiveTab(name) {
  TABS.forEach((t) => {
    document.getElementById(`panel-${t}`).classList.toggle("active", t === name);
    document.getElementById(`nav-${t}`).classList.toggle("active", t === name);
  });
  window.scrollTo({ top: 0, behavior: "instant" });

  // Polling only runs while the tab is actually on screen — leaving it
  // stops the interval outright rather than relying solely on the
  // visibility API, which only covers the whole page being backgrounded,
  // not switching to a different in-app tab.
  if (name === "mirror") renderMirror(document.getElementById("panel-mirror"));
  else stopMirrorPolling();
}

async function init() {
  TABS.forEach((t) => {
    document.getElementById(`nav-${t}`).addEventListener("click", () => setActiveTab(t));
  });
  document.getElementById("btn-settings").addEventListener("click", () => openSettings());
  adoptConfigFromUrl();
  markConnected();
  initMirror({ el, esc });
  // Spotify's login redirect lands back on whichever tab happens to be
  // active by default; if that round-trip is in progress, land on Mirror
  // so the person sees the result immediately instead of Concerts.
  setActiveTab(new URLSearchParams(location.search).has("code") ? "mirror" : "concerts");

  try {
    const [archiveData, recsData, plannedData, historyData, concertCache, artistImageData, setlistData, identityData, originsData] =
      await Promise.all([
        loadJSON("data/archive.json"),
        loadJSON("data/recommendations.json"),
        loadJSON("data/planned.json"),
        loadJSON("data/recommendation-history.json").catch(() => ({ dismissed: [], dismissedIds: [] })),
        loadJSON("data/podiuminfo-cache.json").catch(() => ({ entries: {} })),
        loadJSON("data/artist-images.json").catch(() => ({ artists: {} })),
        loadJSON("data/setlists.json").catch(() => ({ setlists: {} })),
        loadJSON("data/identity.json").catch(() => ({ meta: {} })),
        loadJSON("data/artist-origins.json").catch(() => ({ artists: {} })),
      ]);

    setlists = new Map(Object.entries(setlistData.setlists || {}));

    artistImages = new Map(
      Object.entries(artistImageData.artists || {})
        .filter(([, v]) => v && v.image)
        .map(([key, v]) => [key, v.image])
    );

    concertImageBySourceId = new Map();
    concertImageByVenueDate = new Map();
    concertImageByArtist = new Map();
    for (const [id, v] of Object.entries(concertCache.entries || {})) {
      if (!v || !v.image) continue;
      concertImageBySourceId.set(String(id), v.image);
      if (v.venue && v.date) concertImageByVenueDate.set(`${normalizeKey(v.venue)}|${v.date}`, v.image);
      // The extractor picks the first artist link on the page, i.e. the
      // headliner — so map the photo to lineup[0], not the whole bill.
      const headliner = Array.isArray(v.lineup) ? v.lineup[0] : null;
      if (headliner) {
        const k = normalizeKey(headliner);
        if (!concertImageByArtist.has(k)) concertImageByArtist.set(k, v.image);
      }
    }

    renderArchive(archiveData);
    renderConcerts(recsData, plannedData, historyData);
    initIdentity({ el, esc }, artistImages, archiveConcerts);
    renderIdentity(document.getElementById("panel-identity"), identityData);
    initRealm({ el, esc });
    renderRealm(document.getElementById("panel-realm"), originsData);

    if (getGithubConfig()) askAboutPast(pastPlannedConcerts(historyData));
  } catch (err) {
    console.error(err);
    document.getElementById("panel-concerts").innerHTML =
      `<p class="void">Couldn't load: ${esc(err.message)}</p>`;
  }
}

init();
