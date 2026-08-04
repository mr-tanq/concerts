// identity.js
//
// "Who you are, according to what you play." Built entirely from a single
// static data/identity.json, refreshed twice daily by a GitHub Action —
// there is no live network call here at all, unlike Mirror. An identity
// built from habits is honestly a slower-moving thing than a single
// instant of playback, so a periodic snapshot is the right cadence, not a
// compromise.

let renderDeps = null; // { el, esc } injected from app.js
let artistPhotos = new Map(); // reuses the same artist-images.json the rest of the app already loads
let mode = "overall"; // artists list: "overall" | "month"

export function initIdentity(deps, photos) {
  renderDeps = deps;
  artistPhotos = photos || new Map();
}

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
  const key = (artistName || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  return artistPhotos.get(key) || null;
}

export function renderIdentity(root, data) {
  const { el, esc } = renderDeps;
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
    data.topTracks.slice(0, 10).forEach((t, i) => list.appendChild(rankRow(i + 1, t.name, t.artist, t.playcount, false)));
    root.appendChild(list);
  }

  if (data.topAlbums?.length) {
    root.appendChild(el(`<div class="section-heading">Albums</div>`));
    const list = el(`<div></div>`);
    data.topAlbums.slice(0, 8).forEach((a, i) => list.appendChild(rankRow(i + 1, a.name, a.artist, a.playcount, a.image, true)));
    root.appendChild(list);
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
    artists.forEach((a, i) => list.appendChild(rankRow(i + 1, a.name, null, a.playcount, photoFor(a.name))));
  }
  host.appendChild(list);
}

function rankRow(rank, title, subtitle, playcount, photo, isAlbum = false) {
  const { el, esc } = renderDeps;
  // photo === false means this row type never shows a photo (top tracks) —
  // use the rank number instead. Any other value (a URL, or null for "has
  // a photo slot but this one's missing") gets the photo treatment, so an
  // album with no cover art still reads as an album row, not a numbered one.
  const hasPhotoSlot = photo !== false;
  const row = el(`
    <div class="rank-row ${isAlbum ? "is-album" : ""}">
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
