// identity.js
//
// "Who you are, according to what you play." Built entirely from a single
// static data/identity.json, refreshed twice daily by a GitHub Action —
// there is no live network call here at all, unlike Mirror. An identity
// built from habits is honestly a slower-moving thing than a single
// instant of playback, so a periodic snapshot is the right cadence, not a
// compromise.
//
// The one exception is tapping into an artist: that opens what you've
// actually played by them, and tapping a track there reuses the SAME
// Spotify connection Mirror already set up — no separate login, no new
// secret, just the existing session doing a search-and-play.

import { getValidAccessToken, isSpotifyConnected } from "./spotify-auth.js";
import { actuallySeenArtistsOf } from "./archive-stats.js";

let renderDeps = null; // { el, esc } injected from app.js
let artistPhotos = new Map(); // reuses the same artist-images.json the rest of the app already loads
let archiveConcerts = []; // reused so the artist portrait can say "you've seen them live N times"
let mode = "overall"; // artists list: "overall" | "month"

export function initIdentity(deps, photos, concerts) {
  renderDeps = deps;
  artistPhotos = photos || new Map();
  archiveConcerts = concerts || [];
}

let currentData = null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function withCommas(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function photoFor(artistName) {
  const key = normalizeArtistKey(artistName);
  return artistPhotos.get(key) || null;
}

function normalizeArtistKey(name) {
  return (name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

export function renderIdentity(root, data) {
  const { el, esc } = renderDeps;
  currentData = data;
  root.innerHTML = "";

  if (!data?.meta?.lastUpdated) {
    root.appendChild(el(`
      <div class="stage-empty">
        <p class="whisper">Self</p>
        <p class="lede">Who you are, according to what you play.</p>
        <p class="footnote">Still gathering — this fills in after the identity job first runs.</p>
      </div>
    `));
    return;
  }

  root.appendChild(openingStatement(data));
  root.appendChild(el(`<div id="identity-artists-root"></div>`));

  if (data.topTracks?.length) {
    root.appendChild(el(`<div class="section-heading">Songs you keep coming back to</div>`));
    const list = el(`<div></div>`);
    const status = el(`<p class="status" id="top-tracks-status"></p>`);
    data.topTracks.slice(0, 10).forEach((t, i) => {
      const row = rankRow(i + 1, t.name, t.artist, t.playcount, false);
      row.classList.add("is-tappable");
      row.addEventListener("click", () => playViaSpotify(t.name, t.artist, status));
      list.appendChild(row);
    });
    root.appendChild(list);
    root.appendChild(status);
  }

  if (data.topAlbums?.length) {
    root.appendChild(el(`<div class="section-heading">Albums</div>`));
    const gallery = el(`<div class="album-gallery"></div>`);
    data.topAlbums.slice(0, 10).forEach((a) => gallery.appendChild(albumCard(a)));
    root.appendChild(gallery);
  }

  if (data.recentTracks?.length) {
    root.appendChild(el(`<div class="section-heading">Recently played</div>`));
    const list = el(`<div></div>`);
    data.recentTracks.slice(0, 10).forEach((t) => {
      const row = el(`
        <div class="recent-row">
          <div class="recent-when">${esc(timeAgo(t.playedAt))}</div>
          <div class="recent-body"><b>${esc(t.name)}</b><br><span>${esc(t.artist)}</span></div>
        </div>
      `);
      list.appendChild(row);
    });
    root.appendChild(list);
  }

  if (data.profile?.url) {
    root.appendChild(el(`
      <div class="act-row">
        <button class="plain-act" id="identity-lastfm-link">View on Last.fm</button>
      </div>
    `));
    root.querySelector("#identity-lastfm-link").addEventListener("click", () => window.open(data.profile.url, "_blank"));
  }

  renderArtists(data);
}

// The headline numbers as a sentence, same voice as Archive's opening
// statement — this is the same kind of thing (a life, summarized), just
// measured in scrobbles instead of nights.
function openingStatement(data) {
  const { el, esc } = renderDeps;
  const { totalScrobbles, registeredAt } = data.profile;
  const sinceYear = registeredAt ? new Date(registeredAt).getFullYear() : null;
  const lately = data.topArtistsMonth?.[0]?.name || data.topArtistsOverall?.[0]?.name || null;

  return el(`
    <div class="opening">
      <p class="whisper">Self</p>
      <p class="lede">
        ${withCommas(totalScrobbles)} scrobbles${sinceYear ? ` since ${sinceYear}` : ""}.<br>
        ${lately ? `<em>Lately, you keep returning to ${esc(lately)}.</em>` : ""}
      </p>
    </div>
  `);
}

function renderArtists(data) {
  const { el } = renderDeps;
  const host = document.getElementById("identity-artists-root");
  if (!host) return;
  host.innerHTML = "";

  const bar = el(`
    <div class="identity-modes">
      <div class="explore-modes">
        <button class="explore-mode ${mode === "overall" ? "on" : ""}" data-m="overall">All time</button>
        <button class="explore-mode ${mode === "month" ? "on" : ""}" data-m="month">This month</button>
      </div>
    </div>
  `);
  bar.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => { mode = b.dataset.m; renderArtists(data); });
  });
  host.appendChild(bar);

  const list = el(`<div></div>`);
  const artists = mode === "month" ? data.topArtistsMonth : data.topArtistsOverall;
  if (!artists?.length) {
    list.appendChild(el(`<p class="void">${mode === "month" ? "Nothing tracked yet this month." : "Nothing tracked yet."}</p>`));
  } else {
    artists.forEach((a, i) => {
      const row = rankRow(i + 1, a.name, null, a.playcount, photoFor(a.name));
      row.classList.add("is-tappable");
      row.addEventListener("click", () => openArtistSheet(a.name));
      list.appendChild(row);
    });
  }
  host.appendChild(list);
}

function albumCard(a) {
  const { el, esc } = renderDeps;
  const card = el(`
    <div class="album-card ${a.image ? "" : "is-empty"}">
      <div class="album-card-caption">
        <div class="album-card-name">${esc(a.name)}</div>
        <div class="album-card-count">${withCommas(a.playcount)}× · ${esc(a.artist)}</div>
      </div>
    </div>
  `);
  if (a.image) card.style.backgroundImage = `url("${a.image.replace(/"/g, "%22")}")`;
  return card;
}

function rankRow(rank, title, subtitle, playcount, photo) {
  const { el, esc } = renderDeps;
  // photo === false means this row type never shows a photo (top tracks) —
  // use the rank number instead. Any other value (a URL, or null for "has
  // a photo slot but this one's missing") gets the photo treatment.
  const hasPhotoSlot = photo !== false;
  const row = el(`
    <div class="rank-row">
      ${hasPhotoSlot ? `<div class="rank-photo ${photo ? "" : "is-empty"}"></div>` : `<div class="rank-num">${rank}</div>`}
      <div class="rank-body">
        <div class="rank-name">${esc(title)}</div>
        ${subtitle ? `<div class="rank-sub">${esc(subtitle)}</div>` : ""}
      </div>
      <div class="rank-count">${withCommas(playcount)}×</div>
    </div>
  `);
  if (hasPhotoSlot && photo) row.querySelector(".rank-photo").style.backgroundImage = `url("${photo.replace(/"/g, "%22")}")`;
  return row;
}

// ---------- artist drill-down ----------
//
// Reuses the app's existing full-screen detail pattern (.sheet-root) rather
// than inventing a second one — a night at a show and an artist's own
// track list are the same KIND of thing here: one subject, given the whole
// screen.

// Concerts from the Archive where this artist actually played — headliner,
// support, or festival bill, matched the same way the Archive itself
// counts "most-seen artist", so the numbers never disagree with each other.
function concertsFeaturing(artistName) {
  const key = normalizeArtistKey(artistName);
  return archiveConcerts
    .filter((c) => actuallySeenArtistsOf(c).some((n) => normalizeArtistKey(n) === key))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function fullDate(iso) {
  const [y, m, d] = String(iso || "").split("-");
  return y ? `${Number(d)} ${MONTHS_FULL[Number(m) - 1]} ${y}` : "";
}

// The numbers alone are a dashboard; this turns them into one sentence
// about the actual relationship — how much, how lately, and whether it's
// ever been a night in a room together.
function portraitStatement(overallCount, monthCount, liveCount) {
  const parts = [];
  parts.push(`${withCommas(overallCount)} play${overallCount === 1 ? "" : "s"}`);
  if (monthCount > 0) parts.push(`${monthCount} of those this month alone`);
  let sentence = parts.join(" — ") + ".";
  if (liveCount > 0) {
    sentence += ` <em>You've stood in the room ${spellSmall(liveCount)} time${liveCount === 1 ? "" : "s"}.</em>`;
  } else {
    sentence += ` <em>Never in the same room — yet.</em>`;
  }
  return sentence;
}

const SMALL_WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten"];
function spellSmall(n) { return SMALL_WORDS[n] || String(n); }

function openArtistSheet(artistName) {
  const { el, esc } = renderDeps;
  const root = document.getElementById("settings-modal-root");
  const photo = photoFor(artistName);
  const key = normalizeArtistKey(artistName);
  const tracks = currentData?.topTracksByArtist?.[key] || [];
  const overallCount = currentData?.topArtistsOverall?.find((a) => normalizeArtistKey(a.name) === key)?.playcount || 0;
  const monthCount = currentData?.topArtistsMonth?.find((a) => normalizeArtistKey(a.name) === key)?.playcount || 0;
  const liveShows = concertsFeaturing(artistName);

  root.innerHTML = "";
  const sheet = el(`
    <div class="sheet-root">
      <button class="sheet-close">Close</button>
      <div class="sheet-inner">
        <div class="portrait-photo ${photo ? "" : "is-empty"}">
          <div class="portrait-photo-name">
            <h2 class="portrait-name">${esc(artistName)}</h2>
          </div>
        </div>
        <div class="sheet-head" style="margin-top:22px">
          <p class="lede portrait-statement">${portraitStatement(overallCount, monthCount, liveShows.length)}</p>
        </div>

        ${liveShows.length ? `
          <div class="sheet-section">
            <p class="whisper">Live</p>
            <div id="portrait-live-list"></div>
          </div>` : ""}

        <div class="sheet-section">
          <p class="whisper">${tracks.length ? "What you've been playing" : "Nothing recent"}</p>
          ${!tracks.length ? `<p class="footnote">Last.fm only lets this look at recent listening, not everything ever — this one just hasn't come up lately.</p>` : ""}
          <div id="artist-track-list"></div>
          <p class="status" id="artist-play-status"></p>
        </div>
      </div>
    </div>
  `);
  root.appendChild(sheet);
  if (photo) sheet.querySelector(".portrait-photo").style.backgroundImage = `url("${photo.replace(/"/g, "%22")}")`;
  sheet.querySelector(".sheet-close").addEventListener("click", () => { root.innerHTML = ""; });

  if (liveShows.length) {
    const liveList = sheet.querySelector("#portrait-live-list");
    liveShows.forEach((c) => {
      liveList.appendChild(el(`
        <div class="recent-row">
          <div class="recent-when">${fullDate(c.date).split(" ").slice(0, 2).join(" ")}</div>
          <div class="recent-body"><b>${esc(c.festivalName || c.venue)}</b><br><span>${esc(c.venue)}${c.city ? `, ${esc(c.city)}` : ""}</span></div>
        </div>
      `));
    });
  }

  const list = sheet.querySelector("#artist-track-list");
  const status = sheet.querySelector("#artist-play-status");
  tracks.forEach((t, i) => {
    const row = rankRow(i + 1, t.name, null, t.playcount, false);
    row.classList.add("is-tappable");
    row.addEventListener("click", () => playViaSpotify(t.name, artistName, status));
    list.appendChild(row);
  });
}

// Search-and-play: Last.fm knows what you've listened to, but has no
// playback of its own, so a tapped track is looked up on Spotify by name
// and played there — using the exact same connection Mirror already
// established, not a second login.
async function playViaSpotify(trackName, artistName, status) {
  if (!isSpotifyConnected()) {
    status.textContent = "Connect Spotify in the Mirror tab first.";
    status.className = "status bad";
    return;
  }

  status.textContent = "Finding it on Spotify…";
  status.className = "status";

  try {
    const token = await getValidAccessToken();
    if (!token) throw new Error("Connect Spotify in the Mirror tab first.");

    const q = encodeURIComponent(`track:${trackName} artist:${artistName}`);
    const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!searchRes.ok) throw new Error(`Spotify search failed (HTTP ${searchRes.status}).`);
    const searchJson = await searchRes.json();
    const uri = searchJson?.tracks?.items?.[0]?.uri;
    if (!uri) {
      status.textContent = "Couldn't find that track on Spotify.";
      status.className = "status bad";
      return;
    }

    const playRes = await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [uri] }),
    });
    if (playRes.status === 404) {
      status.textContent = "No active Spotify device — open Spotify somewhere first.";
      status.className = "status bad";
    } else if (playRes.status === 403) {
      status.textContent = "Playback needs Spotify Premium.";
      status.className = "status bad";
    } else if (!playRes.ok && playRes.status !== 204) {
      status.textContent = `Couldn't play that (HTTP ${playRes.status}).`;
      status.className = "status bad";
    } else {
      status.textContent = "Playing — check Mirror.";
      status.className = "status";
    }
  } catch (err) {
    status.textContent = err.message;
    status.className = "status bad";
  }
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
    // Only counts artists actually confirmed via the "who did you really
    // see" picker on each concert (or, for concerts never curated, the
    // full bill — same backward-compatible default actuallySeenArtistsOf
    // uses everywhere else), so Realm can't claim a festival-lineup name
    // you never actually caught.
    const confidentlySeenArtists = new Set();
    for (const c of archiveConcerts) {
      for (const name of actuallySeenArtistsOf(c)) {
        confidentlySeenArtists.add(normalizeKey(name));
      }
    }
    renderRealm(document.getElementById("panel-realm"), originsData, confidentlySeenArtists);

    if (getGithubConfig()) askAboutPast(pastPlannedConcerts(historyData));
  } catch (err) {
    console.error(err);
    document.getElementById("panel-concerts").innerHTML =
      `<p class="void">Couldn't load: ${esc(err.message)}</p>`;
  }
}

init();
