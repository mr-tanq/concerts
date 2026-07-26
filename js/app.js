import { buildArchiveView, filterConcerts } from "./archive-stats.js";

const TABS = ["mirror", "realm", "concerts", "identity", "archive"];
// Session-only queue state for the swipe deck (NOT persisted). The only
// durable outcome of Plan/Dismiss is running the matching GitHub Action —
// see the instruction panel that appears after each swipe. Refreshing the
// page without running that Action will show the card again, by design:
// the browser has no write access to the repo, so nothing here can silently
// pretend to be permanent.
let deckQueue = [];
let lastDecision = null; // { action: "plan" | "dismiss", concert }

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

// ---------- Concerts tab: recommendation deck ----------

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

  if (lastDecision) {
    body.appendChild(decisionBanner(lastDecision));
  }

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

function decisionBanner(decision) {
  const { action, concert } = decision;
  const actionLabel = action === "plan" ? "Plan concert" : "Dismiss concert";
  const verb = action === "plan" ? "Planned" : "Dismissed";
  const banner = el(`
    <div class="card" style="border-color:var(--accent-orange);margin-bottom:16px">
      <div style="font-weight:700;margin-bottom:6px">${verb} (locally) — one step left</div>
      <div class="section-sub" style="margin-bottom:10px">
        This won't be permanent until you run the <strong>"${actionLabel}"</strong> GitHub Action with this id:
      </div>
      <div style="background:var(--card-2);border-radius:8px;padding:10px;font-family:monospace;font-size:13px;word-break:break-all;margin-bottom:10px">${concert.id}</div>
      <button class="btn-copy-id" style="width:100%;border:none;border-radius:10px;padding:10px;font-weight:700;background:#253044;color:var(--text);cursor:pointer">Copy id</button>
    </div>
  `);
  banner.querySelector(".btn-copy-id").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(concert.id);
      e.target.textContent = "Copied ✓";
    } catch {
      e.target.textContent = concert.id;
    }
  });
  return banner;
}

function recommendationCard(c, body) {
  const card = el(`
    <div class="concert-card">
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

  card.querySelector(".btn-skip").addEventListener("click", () => {
    deckQueue.push(deckQueue.shift());
    lastDecision = null;
    renderDeck(body);
  });

  card.querySelector(".btn-hide").addEventListener("click", () => {
    deckQueue.shift();
    lastDecision = { action: "dismiss", concert: c };
    renderDeck(body);
  });

  card.querySelector(".btn-plan").addEventListener("click", () => {
    deckQueue.shift();
    lastDecision = { action: "plan", concert: c };
    renderDeck(body);
  });

  const ticketsBtn = card.querySelector(".btn-tickets");
  if (ticketsBtn) ticketsBtn.addEventListener("click", () => window.open(c.ticketUrl, "_blank"));

  return card;
}

function renderPlannedList(body, plannedData) {
  body.innerHTML = "";
  if (plannedData.concerts.length === 0) {
    body.appendChild(el(`<div class="empty-state">Nothing planned yet. Swipe "Plan" on a recommendation and run the GitHub Action to add it here.</div>`));
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