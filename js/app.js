import { buildArchiveView } from "./archive-stats.js";
import { getGithubConfig, saveGithubConfig, getFile, putFile, testConnection, isConflictError } from "./github-api.js";

const TABS = ["mirror", "realm", "concerts", "identity", "archive"];

// Deck state. Swipes are OPTIMISTIC: the card leaves immediately and the
// GitHub commit runs in the background, because waiting ~2s per swipe for
// three sequential API round-trips made the deck feel broken. If a commit
// fails we surface it and push the card back onto the deck.
let deckQueue = [];
let plannedConcerts = [];
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

// Podiuminfo serves artist photos as "<width>_Name_1.jpg" and links the
// small 100px variant. Bigger variants usually exist at the same path, so
// we optimistically probe for one and swap it in only if it really loads
// at a larger size — some hosts answer a missing size with a placeholder
// rather than a 404, hence the naturalWidth check. Failure is silent: the
// original small image stays.
const IMAGE_SIZE_CANDIDATES = [800, 600, 400, 300, 200];

function upgradeImage(url, apply) {
  if (!url) return;
  const m = url.match(/^(.*\/)(\d+)(_.*\.(?:jpe?g|png))$/i);
  if (!m) return;
  const [, base, size, tail] = m;
  const bigger = IMAGE_SIZE_CANDIDATES.filter((s) => s > Number(size));
  let i = 0;
  const tryNext = () => {
    if (i >= bigger.length) return;
    const candidate = `${base}${bigger[i++]}${tail}`;
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth > Number(size) + 20) apply(candidate);
      else tryNext();
    };
    probe.onerror = tryNext;
    probe.src = candidate;
  };
  tryNext();
}

// ---------- Archive tab ----------

function renderArchive(archiveData) {
  const view = buildArchiveView(archiveData.concerts);
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

  root.appendChild(el(`<div class="section-heading">Patterns</div>`));
  root.appendChild(rankedList("Most seen artists", view.patterns.mostSeenArtists));
  root.appendChild(rankedList("Recurring rooms", view.patterns.recurringRooms));
  root.appendChild(rankedList("Top cities", view.patterns.topCities));

  if (view.onThisDay.length > 0) {
    root.appendChild(el(`<div class="section-heading">On this day</div>`));
    const wrap = el(`<div></div>`);
    view.onThisDay.forEach((c) => wrap.appendChild(timelineCard(c)));
    root.appendChild(wrap);
  }

  root.appendChild(el(`<div class="section-heading">Archive timeline</div>`));
  const timelineWrap = el(`<div></div>`);
  view.timeline.forEach((c) => timelineWrap.appendChild(timelineCard(c)));
  root.appendChild(timelineWrap);
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
}

// ---------- Settings modal ----------

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
      statusEl.textContent = "Connected ✓";
      statusEl.className = "modal-status ok";
      setTimeout(() => { root.innerHTML = ""; }, 700);
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
      statusEl.className = "modal-status error";
    } finally {
      e.target.disabled = false;
      e.target.textContent = "Test & Save";
    }
  });
}

// Festivalinfo serves the artist photo at a small size (the "100_NAME_1.jpg"
// variant). Larger variants MAY exist under the same path with a different
// numeric prefix, but that's an inference about their URL scheme, not
// something documented — so we never rely on it: the small image is applied
// immediately and a bigger one only swaps in if it actually loads.
// Records planned/dismissed before image extraction existed have image:null.
// Rather than leave them permanently photo-less, look the image up from the
// concert cache by the Podiuminfo id we already store on each record.
let concertImageBySourceId = new Map();
let concertImageByVenueDate = new Map();
let concertImageByArtist = new Map();
// Populated at startup purely so the UI can explain itself when a photo is
// missing, instead of failing silently and leaving us guessing.
let imageDiagnostics = { cacheLoaded: false, entries: 0, withImage: 0, artists: 0, error: null };

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

function applyArtistImage(layerEl, url, { blur = 2 } = {}) {
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
    opacity: "0.95",
    zIndex: "0",
    pointerEvents: "none",
  });
  layerEl.style.backgroundImage = `url('${url}')`;

  const bigger = url.replace(/\/(\d+)_([^/]+)$/, "/500_$2");
  if (bigger === url) return;

  const probe = new Image();
  probe.onload = () => {
    if (probe.naturalWidth > 120) layerEl.style.backgroundImage = `url('${bigger}')`;
  };
  probe.src = bigger;
}

// ---------- Concerts tab ----------

function renderConcerts(recsData, plannedData, historyData) {
  deckQueue = [...(recsData.concerts || [])];
  plannedConcerts = [...(plannedData.concerts || [])];
  dismissedConcerts = [...(historyData?.dismissed || [])];

  // Ids dismissed before snapshots existed can still be restored, we just
  // can't render them as full cards — show them as a compact list.
  const snapshotIds = new Set(dismissedConcerts.map((d) => d.id));
  legacyDismissedIds = (historyData?.dismissedIds || []).filter((id) => !snapshotIds.has(id));

  renderConcertsShell();
}

function renderConcertsShell(activeView = "discover") {
  const root = document.getElementById("panel-concerts");
  root.innerHTML = "";
  root.appendChild(el(`<h2 class="section-title">Concerts</h2>`));

  const dismissedCount = dismissedConcerts.length + legacyDismissedIds.length;
  const pills = el(`
    <div class="pill-row">
      <div class="pill ${activeView === "discover" ? "active" : ""}" data-view="discover">Discover (${deckQueue.length})</div>
      <div class="pill ${activeView === "planned" ? "active" : ""}" data-view="planned">Planned (${plannedConcerts.length})</div>
      <div class="pill ${activeView === "dismissed" ? "active" : ""}" data-view="dismissed">Dismissed (${dismissedCount})</div>
    </div>
  `);
  root.appendChild(pills);

  const body = el(`<div id="concerts-body"></div>`);
  root.appendChild(body);

  pills.querySelectorAll(".pill").forEach((p) => {
    p.addEventListener("click", () => renderConcertsShell(p.dataset.view));
  });

  if (activeView === "discover") renderDeck(body);
  else if (activeView === "planned") renderPlannedList(body);
  else renderDismissedList(body);
}

function renderDeck(body) {
  body.innerHTML = "";

  if (deckQueue.length === 0) {
    body.appendChild(el(`<div class="empty-state">Nothing left to swipe. New recommendations arrive when the discovery job next runs.</div>`));
    return;
  }

  const stage = el(`<div class="deck-stage"></div>`);
  stage.appendChild(recommendationCard(deckQueue[0], body));
  body.appendChild(stage);
  body.appendChild(el(`<div class="deck-counter">${deckQueue.length} to review</div>`));
}

function recommendationCard(c, body) {
  const cardImage = imageFor(c);
  const bgLayer = cardImage ? `<div class="card-bg"></div>` : "";
  const support = (c.supportingArtists || []).length
    ? `<div class="support">with ${esc(c.supportingArtists.join(" · "))}</div>`
    : "";
  const timePart = c.time ? ` · ${esc(c.time)}` : "";

  const card = el(`
    <div class="concert-card swipe-card">
      ${bgLayer}
      <div class="swipe-hint plan">Plan</div>
      <div class="swipe-hint dismiss">Nope</div>
      <div class="card-badges">
        <span class="badge-pill">${esc(c.match.label)}</span>
        <span class="badge-pill badge-score">${esc(c.match.score)}</span>
        <span class="badge-pill">${esc(c.city)}</span>
      </div>
      <div class="body">
        <div class="artist">${esc(c.artist)}</div>
        ${support}
        <div class="meta">${esc(c.venue)} · ${formatDateShort(c.date)}${timePart}</div>
        <div class="why">${esc(c.match.reason)}</div>
        <div class="actions">
          <button class="btn-hide" aria-label="Dismiss">✕</button>
          <button class="btn-skip">${c.ticketUrl ? "Tickets" : "Skip"}</button>
          <button class="btn-plan" aria-label="Plan">✓</button>
        </div>
      </div>
    </div>
  `);

  applyArtistImage(card.querySelector(".card-bg"), cardImage);

  const planHint = card.querySelector(".swipe-hint.plan");
  const dismissHint = card.querySelector(".swipe-hint.dismiss");

  let dragging = false, startX = 0, startY = 0, dx = 0, locked = null;
  const threshold = 100;

  function setHints(x) {
    planHint.style.opacity = x > 20 ? String(Math.min(x / threshold, 1)) : "0";
    dismissHint.style.opacity = x < -20 ? String(Math.min(-x / threshold, 1)) : "0";
  }

  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    dragging = true; locked = null;
    startX = e.clientX; startY = e.clientY;
    card.style.transition = "none";
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    // Decide once whether this gesture is a horizontal swipe or a vertical
    // scroll, so swiping never fights the page scroll.
    if (locked === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      locked = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    }
    if (locked !== "x") return;
    dx = mx;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
    setHints(dx);
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    card.style.transition = "transform 0.28s ease, opacity 0.28s ease";
    if (dx > threshold) commit("plan");
    else if (dx < -threshold) commit("dismiss");
    else { card.style.transform = "translateX(0) rotate(0)"; setHints(0); }
    dx = 0;
  }
  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);

  // Optimistic: advance the deck right away, persist in the background.
  function commit(action) {
    if (!getGithubConfig()) {
      card.style.transform = "translateX(0) rotate(0)";
      setHints(0);
      openSettingsModal();
      return;
    }

    const flyX = action === "plan" ? 800 : -800;
    card.style.transform = `translateX(${flyX}px) rotate(${flyX / 22}deg)`;
    card.style.opacity = "0";

    deckQueue.shift();
    if (action === "plan") plannedConcerts.push(plannedRecordFrom(c));
    else dismissedConcerts.unshift({ ...c, dismissedAt: new Date().toISOString() });

    pendingWrites++;
    renderSyncChip();

    const task = enqueue(() => (action === "plan" ? planConcertRemote(c) : dismissConcertRemote(c)));
    task
      .catch((err) => {
        console.error(err);
        syncError = `Couldn't save ${c.artist} — put back in deck`;
        // Undo the optimistic local change so the UI can't drift from the repo.
        deckQueue.push(c);
        if (action === "plan") {
          const i = plannedConcerts.findIndex((p) => p.recommendationId === c.id);
          if (i !== -1) plannedConcerts.splice(i, 1);
        } else {
          const i = dismissedConcerts.findIndex((d) => d.id === c.id);
          if (i !== -1) dismissedConcerts.splice(i, 1);
        }
        renderConcertsShell("discover");
      })
      .finally(() => {
        pendingWrites--;
        renderSyncChip();
      });

    setTimeout(() => renderConcertsShell("discover"), 180);
  }

  card.querySelector(".btn-hide").addEventListener("click", () => commit("dismiss"));
  card.querySelector(".btn-plan").addEventListener("click", () => commit("plan"));
  card.querySelector(".btn-skip").addEventListener("click", () => {
    if (c.ticketUrl) { window.open(c.ticketUrl, "_blank"); return; }
    deckQueue.push(deckQueue.shift());
    renderConcertsShell("discover");
  });

  return card;
}

function renderPlannedList(body) {
  body.innerHTML = "";

  if (plannedConcerts.length === 0) {
    body.appendChild(el(`<div class="empty-state">Nothing planned yet. Swipe right on a recommendation to add it here.</div>`));
    return;
  }
  [...plannedConcerts]
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((c) => body.appendChild(plannedCard(c)));
}

function plannedCard(c) {
  // imageFor() covers records saved before images/sourceId existed, which is
  // most of the existing planned list — using c.image directly here was why
  // these cards stayed blank.
  const cardImage = imageFor(c);
  const support = (c.supportingArtists || []).length
    ? `<div class="support">with ${esc(c.supportingArtists.join(" · "))}</div>`
    : "";

  const card = el(`
    <div class="planned-card" style="position:relative;border-radius:18px;overflow:hidden;min-height:200px;margin-bottom:12px;background:linear-gradient(160deg,#1c2230,#0b0e14);display:flex;flex-direction:column;justify-content:flex-end">
      ${cardImage ? `<div class="card-bg"></div>` : ""}
      <div style="position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(to bottom,rgba(5,7,10,0) 0%,rgba(5,7,10,0) 42%,rgba(5,7,10,0.70) 78%,rgba(5,7,10,0.94) 100%)"></div>
      <div class="planned-body" style="position:relative;z-index:2;padding:14px 16px 16px">
        <div class="artist">${esc(c.artist)}</div>
        ${support}
        <div class="meta">${esc(c.venue)} · ${esc(c.city)}</div>
        <div class="when">${c.date ? formatDate(c.date) : ""}${c.time ? " · " + esc(c.time) : ""}</div>
      </div>
      ${c.ticketUrl ? `<button class="btn-planned-tickets">Tickets</button>` : ""}
    </div>
  `);

  applyArtistImage(card.querySelector(".card-bg"), cardImage, { blur: 1 });

  const t = card.querySelector(".btn-planned-tickets");
  if (t) t.addEventListener("click", (e) => { e.stopPropagation(); window.open(c.ticketUrl, "_blank"); });
  return card;
}

function renderDismissedList(body) {
  body.innerHTML = "";

  const total = dismissedConcerts.length + legacyDismissedIds.length;
  if (total === 0) {
    body.appendChild(el(`<div class="empty-state">Nothing dismissed. Swipe left on a recommendation and it lands here — never permanently gone.</div>`));
    return;
  }

  const restoreAll = el(`
    <button class="btn-restore-all">Restore all ${total} — start a fresh deck</button>
  `);
  restoreAll.addEventListener("click", async () => {
    if (!confirm(`Bring back all ${total} dismissed concerts?`)) return;
    restoreAll.disabled = true;
    restoreAll.textContent = "Restoring…";
    await doRestore([...dismissedConcerts], [...legacyDismissedIds]);
  });
  body.appendChild(restoreAll);

  for (const rec of dismissedConcerts) {
    const row = el(`
      <div class="dismissed-row">
        <div class="dismissed-info">
          <div class="artist">${esc(rec.artist)}</div>
          <div class="meta">${esc(rec.venue)} · ${esc(rec.city)} · ${rec.date ? formatDate(rec.date) : "?"}</div>
        </div>
        <button class="btn-restore">Restore</button>
      </div>
    `);
    row.querySelector(".btn-restore").addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "…";
      await doRestore([rec], []);
    });
    body.appendChild(row);
  }

  if (legacyDismissedIds.length > 0) {
    body.appendChild(el(`<div class="section-heading">Dismissed before details were kept</div>`));
    body.appendChild(el(`
      <p class="section-sub" style="font-size:13px">
        These were dismissed by an older version that only stored ids, so there's
        nothing to preview. Restoring one brings it back on the next discovery run.
      </p>
    `));
    for (const id of legacyDismissedIds) {
      const pretty = id.replace(/^rec-(podiuminfo-)?/, "").replace(/-/g, " ");
      const row = el(`
        <div class="dismissed-row">
          <div class="dismissed-info"><div class="meta">${esc(pretty)}</div></div>
          <button class="btn-restore">Restore</button>
        </div>
      `);
      row.querySelector(".btn-restore").addEventListener("click", async (e) => {
        e.target.disabled = true;
        e.target.textContent = "…";
        await doRestore([], [id]);
      });
      body.appendChild(row);
    }
  }
}

async function doRestore(recs, legacyIds) {
  pendingWrites++;
  renderSyncChip();
  try {
    await enqueue(() => restoreConcertsRemote(recs, legacyIds));
    const restoredIds = new Set([...recs.map((r) => r.id), ...legacyIds]);
    dismissedConcerts = dismissedConcerts.filter((d) => !restoredIds.has(d.id));
    legacyDismissedIds = legacyDismissedIds.filter((id) => !restoredIds.has(id));
    for (const r of recs) {
      const { dismissedAt, ...clean } = r;
      deckQueue.push(clean);
    }
    deckQueue.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
    renderConcertsShell("dismissed");
  } catch (err) {
    console.error(err);
    syncError = `Restore failed: ${err.message}`;
    renderConcertsShell("dismissed");
  } finally {
    pendingWrites--;
    renderSyncChip();
  }
}

// ---------- Tabs ----------

function setActiveTab(name) {
  TABS.forEach((t) => {
    document.getElementById(`panel-${t}`).classList.toggle("active", t === name);
    document.getElementById(`nav-${t}`).classList.toggle("active", t === name);
  });
}

async function init() {
  TABS.forEach((t) => {
    document.getElementById(`nav-${t}`).addEventListener("click", () => setActiveTab(t));
  });
  document.getElementById("btn-settings").addEventListener("click", () => openSettingsModal());
  setActiveTab("concerts");

  try {
    const [archiveData, recsData, plannedData, historyData, concertCache] = await Promise.all([
      loadJSON("data/archive.json"),
      loadJSON("data/recommendations.json"),
      loadJSON("data/planned.json"),
      loadJSON("data/recommendation-history.json").catch(() => ({ dismissed: [], dismissedIds: [] })),
      loadJSON("data/podiuminfo-cache.json").catch((e) => ({ entries: {}, __loadFailed: e.message })),
    ]);

    concertImageBySourceId = new Map();
    concertImageByVenueDate = new Map();
    concertImageByArtist = new Map();
    imageDiagnostics.cacheLoaded = !concertCache.__loadFailed;
    imageDiagnostics.error = concertCache.__loadFailed || null;
    imageDiagnostics.entries = Object.keys(concertCache.entries || {}).length;
    for (const [id, v] of Object.entries(concertCache.entries || {})) {
      if (!v || !v.image) continue;
      concertImageBySourceId.set(String(id), v.image);
      if (v.venue && v.date) {
        concertImageByVenueDate.set(`${normalizeKey(v.venue)}|${v.date}`, v.image);
      }
      // The extractor picks the first artist link on the page, i.e. the
      // headliner — so map the photo to lineup[0], not the whole bill.
      const headliner = Array.isArray(v.lineup) ? v.lineup[0] : null;
      if (headliner) {
        const k = normalizeKey(headliner);
        if (!concertImageByArtist.has(k)) concertImageByArtist.set(k, v.image);
      }
      imageDiagnostics.withImage++;
    }
    imageDiagnostics.artists = concertImageByArtist.size;
    renderArchive(archiveData);
    renderConcerts(recsData, plannedData, historyData);
  } catch (err) {
    console.error(err);
    document.getElementById("panel-concerts").innerHTML =
      `<div class="empty-state">Could not load data: ${esc(err.message)}</div>`;
  }
}

init();
