import { buildArchiveView, filterConcerts, artistsOf, venueKey } from "./archive-stats.js";
import { getGithubConfig, saveGithubConfig, getFile, putFile, testConnection, isConflictError } from "./github-api.js";

const TABS = ["mirror", "realm", "concerts", "identity", "archive"];

// Deck state. Swipes are OPTIMISTIC: the card leaves immediately and the
// GitHub commit runs in the background, because waiting ~2s per swipe for
// three sequential API round-trips made the deck feel broken. If a commit
// fails we surface it and push the card back onto the deck.
let deckQueue = [];
let plannedConcerts = [];
let archiveConcerts = [];
let exploreFilter = { mode: "all", value: null };
let exploreExpanded = false;
let dismissedConcerts = [];   // full snapshots, newest first
let legacyDismissedIds = [];  // ids dismissed before snapshots existed
let pendingWrites = 0;
let syncError = null;

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

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateShort(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}


// ---------- Archive tab ----------

function renderArchive(archiveData) {
  archiveConcerts = archiveData.concerts || [];
  const view = buildArchiveView(archiveConcerts);
  const root = document.getElementById("panel-archive");
  root.innerHTML = "";

  root.appendChild(el(`
    <h2 class="section-title">Archive</h2>
    <p class="section-sub">Your live memory vault — concerts, patterns, and milestones across the years.</p>
  `));

  const overviewGrid = el(`<div class="grid-2"></div>`);
  overviewGrid.appendChild(statCard(view.overview.totalConcerts, "Concerts"));
  overviewGrid.appendChild(statCard(view.overview.festivals, "Festivals"));
  overviewGrid.appendChild(statCard(view.overview.venues, "Venues"));
  overviewGrid.appendChild(statCard(view.overview.cities, "Cities"));
  root.appendChild(el(`<div class="section-heading">Overview</div>`));
  root.appendChild(overviewGrid);

  if (view.signature.topArtist || view.signature.topVenue) {
    const sigGrid = el(`<div class="grid-2"></div>`);
    if (view.signature.topArtist) {
      sigGrid.appendChild(signatureCard(view.signature.topArtist.name,
        `returned to ${view.signature.topArtist.count} times`, "Returning artist"));
    }
    if (view.signature.topVenue) {
      sigGrid.appendChild(signatureCard(view.signature.topVenue.name,
        `${view.signature.topVenue.count} visits`, "Recurring room"));
    }
    root.appendChild(el(`<div class="section-heading">Signature</div>`));
    root.appendChild(sigGrid);
  }

  root.appendChild(el(`<div class="section-heading">Milestones</div>`));
  if (view.milestones.first) root.appendChild(milestoneCard("First concert", view.milestones.first));
  if (view.milestones.latest) root.appendChild(milestoneCard("Latest concert", view.milestones.latest));
  if (view.peakYear) {
    root.appendChild(el(`
      <div class="card stat-card">
        <div class="stat-value">${esc(view.peakYear.name)}</div>
        <div class="stat-label">${esc(view.peakYear.count)} concerts</div>
        <div class="stat-tag">Peak year</div>
      </div>
    `));
  }

  root.appendChild(el(`<div class="section-heading">Patterns</div>`));
  root.appendChild(rankedList("Most seen artists", view.patterns.mostSeenArtists));
  root.appendChild(rankedList("Recurring rooms", view.patterns.recurringRooms));
  root.appendChild(rankedList("Top cities", view.patterns.topCities));

  if (view.onThisDay.length > 0) {
    root.appendChild(el(`<div class="section-heading">On this day</div>`));
    const wrap = el(`<div></div>`);
    view.onThisDay.forEach((c) => wrap.appendChild(archiveCard(c, `${c.yearsAgo} years ago`)));
    root.appendChild(wrap);
  }

  root.appendChild(el(`<div class="section-heading">Explore archive</div>`));
  root.appendChild(el(`<div id="explore-root"></div>`));
  renderExplore(view.explore);
}

// Explore: pick a dimension, then a value, and the timeline below narrows.
// Kept as one function so the mode pills, the value pills and the resulting
// timeline can never disagree about what's currently selected.
function renderExplore(options) {
  const root = document.getElementById("explore-root");
  if (!root) return;
  root.innerHTML = "";

  const MODES = [
    ["all", "All"],
    ["year", "Year"],
    ["artist", "Artist"],
    ["city", "City"],
    ["venue", "Venue"],
  ];

  const modeRow = el(`<div class="pill-row"></div>`);
  for (const [mode, label] of MODES) {
    const pill = el(`<div class="pill ${exploreFilter.mode === mode ? "active" : ""}">${label}</div>`);
    pill.addEventListener("click", () => {
      exploreFilter = { mode, value: null };
      renderExplore(options);
    });
    modeRow.appendChild(pill);
  }
  root.appendChild(modeRow);

  if (exploreFilter.mode !== "all") {
    const values = options[exploreFilter.mode] || [];
    const valueRow = el(`<div class="pill-row"></div>`);
    // Cap the list so a 400-artist archive doesn't render a wall of pills;
    // "+N more" is there when you actually want the long tail.
    const limit = exploreExpanded ? values.length : 10;
    for (const { name, count } of values.slice(0, limit)) {
      const pill = el(`<div class="pill ${exploreFilter.value === name ? "active" : ""}">${esc(name)} <span style="opacity:.55">${count}</span></div>`);
      pill.addEventListener("click", () => {
        exploreFilter = {
          mode: exploreFilter.mode,
          value: exploreFilter.value === name ? null : name,
        };
        renderExplore(options);
      });
      valueRow.appendChild(pill);
    }
    if (values.length > limit) {
      const more = el(`<div class="pill">+${values.length - limit} more</div>`);
      more.addEventListener("click", () => { exploreExpanded = true; renderExplore(options); });
      valueRow.appendChild(more);
    } else if (exploreExpanded && values.length > 10) {
      const less = el(`<div class="pill">Show less</div>`);
      less.addEventListener("click", () => { exploreExpanded = false; renderExplore(options); });
      valueRow.appendChild(less);
    }
    root.appendChild(valueRow);
  }

  const filtered = filterConcerts(archiveConcerts, exploreFilter)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  root.appendChild(el(`
    <div class="section-heading">
      Archive timeline${exploreFilter.value ? ` · ${esc(exploreFilter.value)} (${filtered.length})` : ""}
    </div>
  `));

  const wrap = el(`<div></div>`);
  if (filtered.length === 0) {
    wrap.appendChild(el(`<div class="empty-state">Nothing matches that filter.</div>`));
  } else {
    filtered.forEach((c) => wrap.appendChild(archiveCard(c)));
  }
  root.appendChild(wrap);
}

function statCard(value, label) {
  return el(`
    <div class="card stat-card">
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-label">${esc(label)}</div>
    </div>
  `);
}

function signatureCard(title, sub, tag) {
  return el(`
    <div class="card stat-card">
      <div class="stat-label" style="font-size:20px;font-weight:700;color:var(--text)">${esc(title)}</div>
      <div class="stat-label">${esc(sub)}</div>
      <div class="stat-tag">${esc(tag)}</div>
    </div>
  `);
}

function milestoneCard(kicker, concert) {
  const bg = concert.image
    ? `background-image:linear-gradient(0deg, rgba(5,7,10,.85), rgba(5,7,10,.4)), url('${esc(concert.image)}')`
    : "";
  return el(`
    <div class="milestone-card" style="${bg}">
      <div class="kicker">${esc(kicker)}</div>
      <div class="title">${esc(concert.festivalName || concert.artist)}</div>
      <div class="meta">${formatDate(concert.date)} · ${esc(concert.city)}</div>
      <div class="meta">${esc(concert.venue)}</div>
      <div class="badge">${concert.isFestival ? "FESTIVAL CONCERT" : "OPEN CONCERT"}</div>
    </div>
  `);
}

function rankedList(title, items) {
  const card = el(`<div class="list-card"><div class="section-heading" style="margin:0 0 8px">${esc(title)}</div></div>`);
  items.forEach((item, i) => {
    card.appendChild(el(`
      <div class="list-row">
        <div class="rank">${i + 1}.</div>
        <div class="name">${esc(item.name)}</div>
        <div class="count">${esc(item.count)}</div>
      </div>
    `));
  });
  return card;
}

function timelineCard(c) {
  const title = c.festivalName || c.artist;
  const support = c.supportingArtists?.length ? ` + ${c.supportingArtists.join(" + ")}` : "";
  return el(`
    <div class="timeline-card">
      <div class="artist">${esc(title + support)}</div>
      <div class="meta">${formatDate(c.date)} · ${esc(c.city)}</div>
      <div class="venue">${esc(c.venue)}</div>
    </div>
  `);
}

// ---------- Serialized, conflict-safe repo writes ----------
//
// Swipes are optimistic, so several writes can be triggered within a second
// of each other. Running them concurrently meant they all read the same
// file sha, the first PUT won and the rest failed — which is exactly the
// "some dismisses bounce back into the deck" symptom. Every mutation now
// goes through one serial queue, and each attempt re-reads state and
// re-applies its change, so a conflict (from another tab, or the scheduled
// discovery Action) is resolved by rebasing rather than overwriting.

let writeChain = Promise.resolve();

function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

async function mutate(paths, applyFn, message, attempts = 4) {
  const config = getGithubConfig();
  if (!config) throw new Error("GitHub not connected — open ⚙ to set it up.");

  for (let attempt = 0; ; attempt++) {
    const files = {};
    for (const p of paths) files[p] = await getFile(config, p);

    const jsons = {};
    for (const p of paths) jsons[p] = files[p].json;
    const touched = applyFn(jsons) || paths;

    try {
      for (const p of touched) {
        await putFile(config, p, jsons[p], files[p].sha, message);
      }
      return;
    } catch (err) {
      if (isConflictError(err) && attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue; // re-read, re-apply
      }
      throw err;
    }
  }
}

// ---------- Remote writes ----------

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

    // Keep a full snapshot, not just the id — otherwise a dismissed concert
    // is unreviewable and unrestorable.
    if (!Array.isArray(history.dismissed)) history.dismissed = [];
    if (!history.dismissed.some((d) => d.id === rec.id)) {
      history.dismissed.unshift({ ...rec, dismissedAt: new Date().toISOString() });
    }
  }, `chore: dismiss ${rec.id} (app)`);
}

// Restore = un-dismiss. Removes the id from history AND puts the concert
// straight back into recommendations.json, so it returns to the deck now
// rather than only after the next scheduled discovery run.
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

    // Drop it from the exclude-list, otherwise discovery would keep
    // filtering it out and it could never come back.
    history.plannedIds = (history.plannedIds || []).filter((id) => id !== recId);

    // Put it back in the deck straight away rather than making the user
    // wait for the next scheduled crawl.
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

// ---------- Sync status chip ----------

function renderSyncChip() {
  document.getElementById("sync-chip")?.remove();
  if (pendingWrites === 0 && !syncError) return;

  const chip = syncError
    ? el(`<div class="sync-chip error" id="sync-chip">${esc(syncError)}</div>`)
    : el(`<div class="sync-chip" id="sync-chip">Saving ${pendingWrites}…</div>`);
  document.body.appendChild(chip);

  if (syncError) {
    setTimeout(() => {
      syncError = null;
      renderSyncChip();
    }, 6000);
  }
    }// ---------- Settings modal ----------

function openSettingsModal() {
  const existing = getGithubConfig() || { owner: "", repo: "", token: "" };
  const root = document.getElementById("settings-modal-root");
  root.innerHTML = "";
  const overlay = el(`
    <div class="modal-overlay">
      <div class="modal-sheet">
        <h3>Connect GitHub</h3>
        <p class="hint">
          Lets swipes save straight to your repo. Create a
          <strong>fine-grained token</strong> at github.com/settings/tokens?type=beta,
          scoped to <strong>only this repo</strong>, with
          <strong>Contents: Read and write</strong>. Stored only in this browser.
        </p>
        ${storageIsPersistent() ? "" : `<div class="modal-status error">This browser isn't keeping local storage — private/incognito windows clear it when the tab closes, which is why the token keeps disappearing. Use a normal tab, or add the site to your home screen.</div>`}
        <label>Repo owner</label>
        <input id="input-owner" type="text" placeholder="mr-tanq" value="${esc(existing.owner)}" />
        <label>Repo name</label>
        <input id="input-repo" type="text" placeholder="concerts" value="${esc(existing.repo)}" />
        <label>Access token</label>
        <input id="input-token" type="password" placeholder="github_pat_..." value="${esc(existing.token)}" />
        <div class="modal-status" id="modal-status"></div>
        <div class="modal-actions">
          <button class="btn-modal-cancel" id="btn-modal-cancel">Cancel</button>
          <button class="btn-modal-save" id="btn-modal-save">Test &amp; Save</button>
        </div>
      </div>
    </div>
  `);
  root.appendChild(overlay);

  const statusEl = overlay.querySelector("#modal-status");
  overlay.querySelector("#btn-modal-cancel").addEventListener("click", () => { root.innerHTML = ""; });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) root.innerHTML = ""; });

  overlay.querySelector("#btn-modal-save").addEventListener("click", async (e) => {
    const owner = overlay.querySelector("#input-owner").value.trim();
    const repo = overlay.querySelector("#input-repo").value.trim();
    const token = overlay.querySelector("#input-token").value.trim();
    if (!owner || !repo || !token) {
      statusEl.textContent = "Fill in all three fields.";
      statusEl.className = "modal-status error";
      return;
    }
    const config = { owner, repo, token };
    e.target.disabled = true;
    e.target.textContent = "Testing…";
    statusEl.textContent = "";
    try {
      await testConnection(config);
      saveGithubConfig(config);
      statusEl.innerHTML = `Connected ✓ — <a href="#" id="lnk-bookmark" style="color:var(--accent-blue)">copy a setup link</a> to restore this instantly later.`;
      statusEl.className = "modal-status ok";
      overlay.querySelector("#lnk-bookmark").addEventListener("click", async (ev) => {
        ev.preventDefault();
        const url = `${location.origin}${location.pathname}?gh=${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${token}`;
        try {
          await navigator.clipboard.writeText(url);
          ev.target.textContent = "copied — bookmark it";
        } catch {
          prompt("Copy this link:", url);
        }
      });
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
      statusEl.className = "modal-status error";
    } finally {
      e.target.disabled = false;
      e.target.textContent = "Test & Save";
    }
  });
}

// Records planned/dismissed before image extraction existed have image:null.
// Rather than leave them permanently photo-less, look the image up from the
// concert cache.
let concertImageBySourceId = new Map();
let concertImageByVenueDate = new Map();
let concertImageByArtist = new Map();

function normalizeKey(s) {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

// The image Podiuminfo exposes is the ARTIST's photo, not concert artwork
// (the URL is literally /img/artist/<id>/...). So the artist name is the
// natural key, and any cached concert featuring that artist yields it —
// which is what rescues records saved before the schema carried sourceId.
// The id/venue routes stay as extra safety nets.
function imageFor(rec) {
  if (rec.image) return rec.image;

  const byArtist = concertImageByArtist.get(normalizeKey(rec.artist));
  if (byArtist) return byArtist;

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

function applyArtistImage(layerEl, url, { blur = 2, dim = 1 } = {}) {
  if (!layerEl || !url) return;

  // Critical geometry is set inline rather than left to a stylesheet class.
  // A stale css/style.css previously meant the layer rendered with no size
  // and the photo silently never appeared — inline styles make the element
  // self-sufficient.
  Object.assign(layerEl.style, {
    position: "absolute",
    inset: "0",
    backgroundSize: "cover",
    backgroundPosition: "center",
    filter: `blur(${blur}px) saturate(1.1)`,
    transform: "scale(1.04)",
    opacity: String(0.95 * dim),
    zIndex: "0",
    pointerEvents: "none",
  });
  layerEl.style.backgroundImage = `url('${url}')`;

  // Festivalinfo serves the photo small (the "100_NAME_1.jpg" variant).
  // A larger variant MAY exist under the same path with a different numeric
  // prefix, but that's an inference about their URL scheme, not something
  // documented — so the small one is applied immediately and a bigger one
  // only swaps in if it actually loads.
  const bigger = url.replace(/\/(\d+)_([^/]+)$/, "/500_$2");
  if (bigger === url) return;

  const probe = new Image();
  probe.onload = () => {
    if (probe.naturalWidth > 120) layerEl.style.backgroundImage = `url('${bigger}')`;
  };
  probe.src = bigger;
}

// GitHub Pages serves data/*.json through a CDN that can keep returning the
// previous version for a few minutes after a commit. That made freshly
// dismissed concerts reappear on refresh. Two defences: filter the loaded
// deck against the history lists, and keep a short-lived local record of
// what we just acted on, since the history file can be stale too.
const RECENT_KEY = "lm_recently_handled";
const RECENT_TTL_MS = 30 * 60 * 1000;

function loadRecentlyHandled() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}");
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw).filter(([, t]) => now - t < RECENT_TTL_MS));
  } catch {
    return {};
  }
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

// ---------- Archive concert card + detail ----------

function archiveCard(c, badge = null) {
  const cardImage = imageFor(c);
  const support = (c.supportingArtists || []).length
    ? `<div class="support">with ${esc(c.supportingArtists.join(" · "))}</div>`
    : "";
  const card = el(`
    <div class="archive-card">
      ${cardImage ? `<div class="card-bg"></div>` : ""}
      <div class="archive-scrim"></div>
      <div class="archive-body">
        ${badge ? `<div class="archive-badge">${esc(badge)}</div>` : ""}
        <div class="artist">${esc(c.festivalName || c.artist)}</div>
        ${support}
        <div class="meta">${c.date ? formatDate(c.date) : ""} · ${esc(c.city)}</div>
        <div class="venue">${esc(c.venue)}</div>
      </div>
    </div>
  `);
  applyArtistImage(card.querySelector(".card-bg"), cardImage, { blur: 1 });
  card.addEventListener("click", () => openConcertDetail(c));
  return card;
}

function openConcertDetail(c) {
  const root = document.getElementById("settings-modal-root");
  const cardImage = imageFor(c);
  const lineup = artistsOf(c);
  const headliner = c.festivalName || c.artist;
  const support = lineup.filter((n) => n !== c.artist);
  const room = venueKey(c);

  root.innerHTML = "";
  const overlay = el(`
    <div class="modal-overlay detail-overlay">
      <div class="detail-sheet">
        <div class="detail-hero">
          ${cardImage ? `<div class="card-bg"></div>` : ""}
          <div class="detail-hero-scrim"></div>
          <button class="detail-close" aria-label="Close">✕</button>
          <div class="detail-hero-text">
            <div class="detail-title">${esc(headliner)}</div>
            <div class="detail-sub">${c.date ? formatDate(c.date) : ""} · ${esc(c.city)} · ${esc(c.venue)}</div>
          </div>
        </div>

        <div class="detail-body">
          <div class="grid-2">
            <div class="card stat-card">
              <div class="stat-tag" style="margin:0 0 6px">Artist</div>
              <div>${esc(c.artist)}</div>
            </div>
            <div class="card stat-card">
              <div class="stat-tag" style="margin:0 0 6px">Venue</div>
              <div>${esc(c.venue)}</div>
            </div>
            <div class="card stat-card">
              <div class="stat-tag" style="margin:0 0 6px">City</div>
              <div>${esc(c.city)}${c.country ? ` · ${esc(c.country)}` : ""}</div>
            </div>
            <div class="card stat-card">
              <div class="stat-tag" style="margin:0 0 6px">Type</div>
              <div>${c.isFestival ? "Festival" : "Concert"}</div>
            </div>
          </div>

          ${room && room !== c.venue ? `
            <div class="section-heading">Venue family</div>
            <div class="pill-row"><div class="pill">${esc(room)}</div></div>
          ` : ""}

          ${support.length ? `
            <div class="section-heading">${c.isFestival ? "Lineup" : "Support"}</div>
            <div class="pill-row">${support.map((n) => `<div class="pill">${esc(n)}</div>`).join("")}</div>
          ` : ""}

          <div class="section-heading">Notes</div>
          <div id="detail-notes"></div>
        </div>
      </div>
    </div>
  `);
  root.appendChild(overlay);

  applyArtistImage(overlay.querySelector(".card-bg"), cardImage, { blur: 3 });
  overlay.querySelector(".detail-close").addEventListener("click", () => { root.innerHTML = ""; });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) root.innerHTML = ""; });

  renderNotes(overlay.querySelector("#detail-notes"), c);
}

function renderNotes(host, c) {
  host.innerHTML = "";
  const hasNote = !!(c.notes && c.notes.trim());

  const view = el(`
    <div>
      <p class="section-sub" style="margin-bottom:10px">${hasNote ? esc(c.notes) : "No notes yet."}</p>
      <button class="btn-note">${hasNote ? "Edit note" : "Add note"}</button>
    </div>
  `);
  view.querySelector(".btn-note").addEventListener("click", () => {
    const editor = el(`
      <div>
        <textarea class="note-input" rows="4" placeholder="What do you remember?">${esc(c.notes || "")}</textarea>
        <div class="modal-status" id="note-status"></div>
        <div class="modal-actions">
          <button class="btn-modal-cancel" id="note-cancel">Cancel</button>
          <button class="btn-modal-save" id="note-save">Save</button>
        </div>
      </div>
    `);
    host.innerHTML = "";
    host.appendChild(editor);

    const status = editor.querySelector("#note-status");
    editor.querySelector("#note-cancel").addEventListener("click", () => renderNotes(host, c));
    editor.querySelector("#note-save").addEventListener("click", async (e) => {
      if (!getGithubConfig()) { openSettingsModal(); return; }
      const text = editor.querySelector(".note-input").value.trim();
      e.target.disabled = true;
      e.target.textContent = "Saving…";
      try {
        await enqueue(() => saveConcertNoteRemote(c, text));
        c.notes = text;                        // keep the open sheet in sync
        const local = archiveConcerts.find((x) => x.id === c.id);
        if (local) local.notes = text;
        renderNotes(host, c);
      } catch (err) {
        console.error(err);
        status.textContent = `Couldn't save: ${err.message}`;
        status.className = "modal-status error";
        e.target.disabled = false;
        e.target.textContent = "Save";
      }
    });
  });
  host.appendChild(view);
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
