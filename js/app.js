import { buildArchiveView, filterConcerts } from "./archive-stats.js";
import { getGithubConfig, saveGithubConfig, getFile, putFile, testConnection } from "./github-api.js";

const TABS = ["mirror", "realm", "concerts", "identity", "archive"];
// Session-only deck order. The COMMITTED outcome of a swipe (Plan/Dismiss)
// is a direct GitHub API write (see planConcertRemote/dismissConcertRemote
// below) — the browser holds a fine-grained Personal Access Token in
// localStorage and calls api.github.com directly, so swiping is
// immediately permanent, no manual Action step needed.
let deckQueue = [];

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

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
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
    const onThisDayWrap = el(`<div></div>`);
    view.onThisDay.forEach((c) => onThisDayWrap.appendChild(timelineCard(c)));
    root.appendChild(onThisDayWrap);
  }

  root.appendChild(el(`<div class="section-heading">Explore archive</div>`));
  const filterPills = el(`
    <div class="pill-row">
      <div class="pill active" data-filter="all">All</div>
      <div class="pill" data-filter="year">Year</div>
      <div class="pill" data-filter="artist">Artist</div>
      <div class="pill" data-filter="city">City</div>
      <div class="pill" data-filter="venue">Venue</div>
    </div>
  `);
  root.appendChild(filterPills);

  root.appendChild(el(`<div class="section-heading">Archive timeline</div>`));
  const timelineWrap = el(`<div></div>`);
  view.timeline.forEach((c) => timelineWrap.appendChild(timelineCard(c)));
  root.appendChild(timelineWrap);
}

function statCard(value, label) {
  return el(`
    <div class="card stat-card">
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
    </div>
  `);
}

function signatureCard(title, sub, tag) {
  return el(`
    <div class="card stat-card">
      <div class="stat-label" style="font-size:20px;font-weight:700;color:var(--text)">${title}</div>
      <div class="stat-label">${sub}</div>
      <div class="stat-tag">${tag}</div>
    </div>
  `);
}

function milestoneCard(kicker, concert) {
  const bg = concert.image ? `background-image:linear-gradient(0deg, rgba(5,7,10,.85), rgba(5,7,10,.4)), url('${concert.image}')` : "";
  return el(`
    <div class="milestone-card" style="${bg}">
      <div class="kicker">${kicker}</div>
      <div class="title">${concert.festivalName || concert.artist}</div>
      <div class="meta">${formatDate(concert.date)} · ${concert.city}</div>
      <div class="meta">${concert.venue}</div>
      <div class="badge">${concert.isFestival ? "FESTIVAL CONCERT" : "OPEN CONCERT"}</div>
    </div>
  `);
}

function rankedList(title, items) {
  const card = el(`<div class="list-card"><div class="section-heading" style="margin:0 0 8px">${title}</div></div>`);
  items.forEach((item, i) => {
    card.appendChild(el(`
      <div class="list-row">
        <div class="rank">${i + 1}.</div>
        <div class="name">${item.name}</div>
        <div class="count">${item.count}</div>
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
      <div class="artist">${title}${support}</div>
      <div class="meta">${formatDate(c.date)} · ${c.city}</div>
      <div class="venue">${c.venue}</div>
    </div>
  `);
}

// ---------- Remote plan/dismiss (mirrors scripts/plan-concert.mjs and scripts/dismiss-concert.mjs) ----------

async function planConcertRemote(rec) {
  const config = getGithubConfig();
  if (!config) throw new Error("not-configured");

  const [recs, planned, history] = await Promise.all([
    getFile(config, "data/recommendations.json"),
    getFile(config, "data/planned.json"),
    getFile(config, "data/recommendation-history.json"),
  ]);

  const idx = recs.json.concerts.findIndex((c) => c.id === rec.id);
  if (idx === -1) throw new Error("This recommendation no longer exists (maybe already handled elsewhere).");
  const r = recs.json.concerts[idx];

  const plannedRecord = {
    id: `planned-${r.id.replace(/^rec-/, "")}`,
    artist: r.artist,
    supportingArtists: r.supportingArtists || [],
    date: r.date,
    time: r.time || null,
    venue: r.venue,
    city: r.city,
    country: r.country,
    isFestival: r.isFestival || false,
    image: r.image || null,
    ticketUrl: r.ticketUrl || null,
    sourceApis: r.sourceApis || [],
    recommendationId: r.id,
    planning: { plannedAt: new Date().toISOString(), originalScore: r.match?.score ?? null },
  };

  const dup = planned.json.concerts.some(
    (c) => c.artist === plannedRecord.artist && c.date === plannedRecord.date && c.venue === plannedRecord.venue
  );
  if (!dup) planned.json.concerts.push(plannedRecord);
  planned.json.meta.lastUpdated = new Date().toISOString();

  recs.json.concerts.splice(idx, 1);
  recs.json.meta.lastUpdated = new Date().toISOString();

  if (!history.json.plannedIds.includes(r.id)) history.json.plannedIds.push(r.id);

  await putFile(config, "data/planned.json", planned.json, planned.sha, `chore: plan ${r.id} (via app)`);
  await putFile(config, "data/recommendations.json", recs.json, recs.sha, `chore: remove planned ${r.id} from recommendations (via app)`);
  await putFile(config, "data/recommendation-history.json", history.json, history.sha, `chore: mark ${r.id} planned (via app)`);
}

async function dismissConcertRemote(rec) {
  const config = getGithubConfig();
  if (!config) throw new Error("not-configured");

  const [recs, history] = await Promise.all([
    getFile(config, "data/recommendations.json"),
    getFile(config, "data/recommendation-history.json"),
  ]);

  const idx = recs.json.concerts.findIndex((c) => c.id === rec.id);
  if (idx !== -1) {
    recs.json.concerts.splice(idx, 1);
    recs.json.meta.lastUpdated = new Date().toISOString();
  }
  if (!history.json.dismissedIds.includes(rec.id)) history.json.dismissedIds.push(rec.id);

  await putFile(config, "data/recommendations.json", recs.json, recs.sha, `chore: dismiss ${rec.id} (via app)`);
  await putFile(config, "data/recommendation-history.json", history.json, history.sha, `chore: mark ${rec.id} dismissed (via app)`);
}

// ---------- Settings modal (GitHub connection) ----------

function openSettingsModal() {
  const existing = getGithubConfig() || { owner: "", repo: "", token: "" };
  const root = document.getElementById("settings-modal-root");
  root.innerHTML = "";
  const overlay = el(`
    <div class="modal-overlay">
      <div class="modal-sheet">
        <h3>Connect GitHub</h3>
        <p class="hint">
          Lets swipes commit directly to your repo — no manual Action step.
          Create a <strong>fine-grained Personal Access Token</strong> at
          github.com → Settings → Developer settings → Personal access
          tokens → Fine-grained tokens, scoped to <strong>only this repo</strong>,
          with <strong>Contents: Read and write</strong> permission. It's
          stored only in this browser's local storage.
        </p>
        <label>Repo owner (username)</label>
        <input id="input-owner" type="text" placeholder="mr-tanq" value="${existing.owner || ""}" />
        <label>Repo name</label>
        <input id="input-repo" type="text" placeholder="concerts" value="${existing.repo || ""}" />
        <label>Personal access token</label>
        <input id="input-token" type="password" placeholder="github_pat_..." value="${existing.token || ""}" />
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
    e.target.textContent = "Testing...";
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

function renderConcerts(recsData, plannedData) {
  deckQueue = [...recsData.concerts];
  const root = document.getElementById("panel-concerts");
  renderConcertsShell(root, plannedData);
}

function renderConcertsShell(root, plannedData) {
  root.innerHTML = "";
  root.appendChild(el(`
    <h2 class="section-title">Concerts</h2>
    <p class="section-sub">Recommendations from your listening — nothing is planned automatically. You decide.</p>
  `));

  const pills = el(`
    <div class="pill-row">
      <div class="pill active" data-view="discover">Discover</div>
      <div class="pill" data-view="planned">Planned (${plannedData.concerts.length})</div>
    </div>
  `);
  root.appendChild(pills);

  const body = el(`<div id="concerts-body"></div>`);
  root.appendChild(body);

  pills.querySelectorAll(".pill").forEach((p) => {
    p.addEventListener("click", () => {
      pills.querySelectorAll(".pill").forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
      if (p.dataset.view === "discover") renderDeck(body);
      else renderPlannedList(body, plannedData);
    });
  });

  renderDeck(body);
}

function renderDeck(body) {
  body.innerHTML = "";

  if (deckQueue.length === 0) {
    body.appendChild(el(`<div class="empty-state">No more recommendations right now. The discovery job runs on a schedule — check back soon.</div>`));
    return;
  }

  const current = deckQueue[0];
  body.appendChild(recommendationCard(current, body));
  if (deckQueue.length > 1) {
    body.appendChild(el(`<p style="text-align:center;color:var(--text-faint);font-size:13px;margin-top:8px">${deckQueue.length - 1} more after this</p>`));
  }
}

function recommendationCard(c, body) {
  const card = el(`
    <div class="concert-card swipe-card" style="position:relative">
      <div class="swipe-hint plan">Plan</div>
      <div class="swipe-hint dismiss">Nope</div>
      ${c.image ? `<div class="image" style="background-image:url('${c.image}')"></div>` : ""}
      <div class="body">
        <div class="artist">${c.artist}${c.supportingArtists?.length ? ` + ${c.supportingArtists.join(" + ")}` : ""}</div>
        <div class="meta">${c.venue} · ${c.city} · ${formatDate(c.date)}${c.time ? " · " + c.time : ""}</div>
        <div class="why">Why this: ${c.match.reason}</div>
        <div class="match-line">${c.match.label} · Score ${c.match.score}</div>
        <div class="actions">
          <button class="btn-hide">Dismiss</button>
          <button class="btn-skip">Skip</button>
          <button class="btn-plan">Plan</button>
        </div>
        ${c.ticketUrl ? `<button class="btn-tickets" style="width:100%;margin-top:10px;border:none;border-radius:10px;padding:12px;font-weight:700;background:#1f3350;color:#8ec1ff;cursor:pointer">Tickets</button>` : ""}
      </div>
    </div>
  `);

  const planHint = card.querySelector(".swipe-hint.plan");
  const dismissHint = card.querySelector(".swipe-hint.dismiss");

  let dragging = false;
  let startX = 0;
  let currentX = 0;
  const threshold = 110;

  function setHints(x) {
    planHint.style.opacity = x > 20 ? String(Math.min(x / threshold, 1)) : "0";
    dismissHint.style.opacity = x < -20 ? String(Math.min(-x / threshold, 1)) : "0";
  }

  function onPointerDown(e) {
    if (e.target.closest("button")) return;
    dragging = true;
    startX = e.clientX;
    card.style.transition = "none";
    card.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    if (!dragging) return;
    currentX = e.clientX - startX;
    card.style.transform = `translateX(${currentX}px) rotate(${currentX / 20}deg)`;
    setHints(currentX);
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    card.style.transition = "transform 0.25s ease, opacity 0.25s ease";
    if (currentX > threshold) {
      resolveSwipe("plan");
    } else if (currentX < -threshold) {
      resolveSwipe("dismiss");
    } else {
      card.style.transform = "translateX(0) rotate(0)";
      setHints(0);
    }
    currentX = 0;
  }

  card.addEventListener("pointerdown", onPointerDown);
  card.addEventListener("pointermove", onPointerMove);
  card.addEventListener("pointerup", onPointerUp);
  card.addEventListener("pointercancel", onPointerUp);

  async function resolveSwipe(action) {
    if (!getGithubConfig()) {
      card.style.transform = "translateX(0) rotate(0)";
      setHints(0);
      openSettingsModal();
      return;
    }

    const flyX = action === "plan" ? 700 : -700;
    card.style.transform = `translateX(${flyX}px) rotate(${flyX / 20}deg)`;
    card.style.opacity = "0";

    const overlay = el(`<div class="card-loading-overlay">${action === "plan" ? "Planning…" : "Dismissing…"}</div>`);
    card.appendChild(overlay);

    try {
      if (action === "plan") await planConcertRemote(c);
      else await dismissConcertRemote(c);
      deckQueue.shift();
      renderDeck(body);
    } catch (err) {
      console.error(err);
      card.style.transition = "none";
      card.style.transform = "translateX(0) rotate(0)";
      card.style.opacity = "1";
      overlay.remove();
      setHints(0);
      const banner = el(`<div class="error-banner">Couldn't save: ${err.message}</div>`);
      body.insertBefore(banner, card);
    }
  }

  card.querySelector(".btn-skip").addEventListener("click", () => {
    deckQueue.push(deckQueue.shift());
    renderDeck(body);
  });
  card.querySelector(".btn-hide").addEventListener("click", () => resolveSwipe("dismiss"));
  card.querySelector(".btn-plan").addEventListener("click", () => resolveSwipe("plan"));

  const ticketsBtn = card.querySelector(".btn-tickets");
  if (ticketsBtn) ticketsBtn.addEventListener("click", () => window.open(c.ticketUrl, "_blank"));

  return card;
}

function renderPlannedList(body, plannedData) {
  body.innerHTML = "";
  if (plannedData.concerts.length === 0) {
    body.appendChild(el(`<div class="empty-state">Nothing planned yet. Swipe right (or tap Plan) on a recommendation to add it here.</div>`));
    return;
  }
  [...plannedData.concerts]
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((c) => body.appendChild(timelineCard(c)));
}

// ---------- Tab switching ----------

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
  setActiveTab("archive");

  try {
    const [archiveData, recsData, plannedData] = await Promise.all([
      loadJSON("data/archive.json"),
      loadJSON("data/recommendations.json"),
      loadJSON("data/planned.json"),
    ]);
    renderArchive(archiveData);
    renderConcerts(recsData, plannedData);
  } catch (err) {
    console.error(err);
    document.getElementById("panel-archive").innerHTML =
      `<div class="empty-state">Could not load data: ${err.message}</div>`;
  }
}

init();