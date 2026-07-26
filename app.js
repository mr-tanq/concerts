import { buildArchiveView, filterConcerts } from "./archive-stats.js";

const TABS = ["mirror", "realm", "concerts", "identity", "archive"];
const HIDDEN_KEY = "lm_hidden_planned_ids";
const GOING_KEY = "lm_going_planned_ids";

function getIdSet(storageKey) {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey) || "[]"));
  } catch {
    return new Set();
  }
}
function addIdToSet(storageKey, id) {
  const set = getIdSet(storageKey);
  set.add(id);
  localStorage.setItem(storageKey, JSON.stringify([...set]));
}
function getHiddenIds() { return getIdSet(HIDDEN_KEY); }
function hideId(id) { addIdToSet(HIDDEN_KEY, id); }
function markGoing(id) { addIdToSet(GOING_KEY, id); }
// NOTE: "Plan"/"Hide" are stored in the browser's localStorage only — this is a
// static site with no write-back to GitHub from the client. When you actually
// attend a "going" concert, run the import workflow (see README) to move it
// into data/archive.json for good. This is the one manual step in an
// otherwise fully automated pipeline.

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

// ---------- Concerts tab ----------

function renderConcerts(plannedData) {
  const root = document.getElementById("panel-concerts");
  root.innerHTML = "";
  root.appendChild(el(`
    <h2 class="section-title">Concerts</h2>
    <p class="section-sub">Signals from your listening. Live shows you might actually care about.</p>
  `));

  const hidden = getHiddenIds();
  const visible = plannedData.concerts.filter(
    (c) => c.status === "active" && !c.hidden && !hidden.has(c.id)
  );

  if (visible.length === 0) {
    root.appendChild(el(`<div class="empty-state">No live matches right now. The discovery job runs on a schedule — check back soon.</div>`));
    return;
  }

  visible.forEach((c) => root.appendChild(concertCard(c)));
}

function concertCard(c) {
  const card = el(`
    <div class="concert-card">
      ${c.image ? `<div class="image" style="background-image:url('${c.image}')"></div>` : ""}
      <div class="body">
        <div class="artist">${c.artist}</div>
        <div class="meta">${c.venue} · ${c.city} · ${formatDate(c.date)}${c.time ? " · " + c.time : ""}</div>
        <div class="why">Why this: ${c.match.reason}</div>
        <div class="match-line">${c.match.label} · Score ${c.match.score} · Matched by ${c.match.matchedBy}</div>
        <div class="actions">
          <button class="btn-plan">Plan</button>
          <button class="btn-hide">Hide</button>
          ${c.ticketUrl ? `<button class="btn-tickets">Tickets</button>` : ""}
        </div>
      </div>
    </div>
  `);
  card.querySelector(".btn-hide").addEventListener("click", () => {
    hideId(c.id);
    card.remove();
  });
  card.querySelector(".btn-plan").addEventListener("click", (e) => {
    markGoing(c.id);
    e.target.textContent = "Going ✓";
    e.target.disabled = true;
  });
  const ticketsBtn = card.querySelector(".btn-tickets");
  if (ticketsBtn) ticketsBtn.addEventListener("click", () => window.open(c.ticketUrl, "_blank"));
  return card;
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
  setActiveTab("archive");

  try {
    const [archiveData, plannedData] = await Promise.all([
      loadJSON("data/archive.json"),
      loadJSON("data/planned.json"),
    ]);
    renderArchive(archiveData);
    renderConcerts(plannedData);
  } catch (err) {
    console.error(err);
    document.getElementById("panel-archive").innerHTML =
      `<div class="empty-state">Could not load data: ${err.message}</div>`;
  }
}

init();
