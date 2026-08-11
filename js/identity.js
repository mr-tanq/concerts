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

// Last.fm and the Archive don't always agree on how much of a stage name
// to use — Last.fm's own artist database has "Gonzales" for the person
// this app's Archive correctly knows as "Chilly Gonzales". An exact key
// match misses this entirely. A plain substring check would be too loose
// (it would happily match "Muse" inside "Museum"), so this only accepts a
// match where the shorter name is a whole word, or whole leading/trailing
// word-sequence, of the longer one.
function keysLikelyMatch(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return longer.startsWith(shorter + " ") || longer.endsWith(" " + shorter);
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

function concertsFeaturing(artistName) {
  const key = normalizeArtistKey(artistName);
  return archiveConcerts
    .filter((c) => actuallySeenArtistsOf(c).some((n) => keysLikelyMatch(normalizeArtistKey(n), key)))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function fullDate(iso) {
  const [y, m, d] = String(iso || "").split("-");
  return y ? `${Number(d)} ${MONTHS_FULL[Number(m) - 1]} ${y}` : "";
}

// Compact form for the narrow "recent-when" column — day + short month +
// year, e.g. "12 Nov 2025". The previous code built this by truncating
// fullDate()'s output to its first two words, which silently dropped the
// year every time.
function shortDateWithYear(iso) {
  const [y, m, d] = String(iso || "").split("-");
  return y ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` : "";
}

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
          <div class="recent-when">${shortDateWithYear(c.date)}</div>
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