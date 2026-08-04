// mirror.js
//
// The "what's playing right now" tab. Polls Spotify while this tab is on
// screen, shows the current lyric line in the app's existing editorial
// voice (the same big serif used for archive statements elsewhere — a
// lyric line IS that kind of sentence), and stays completely quiet the
// rest of the time: no polling when the tab isn't visible, no network
// calls at all until Spotify is actually connected.

import {
  getSpotifyConfig, saveSpotifyConfig, isSpotifyConnected, disconnectSpotify,
  beginSpotifyLogin, completeSpotifyLoginIfRedirected, getValidAccessToken,
} from "./spotify-auth.js";
import { getSyncedLyrics, currentLine } from "./lyrics.js";

const POLL_MS = 5000;
// How often the lyric line re-checks itself against elapsed time. Spotify
// itself is only asked once every POLL_MS — this just interpolates between
// those answers using the browser's own clock, the same technique any
// lyric-sync player uses, so the line changes when it should instead of in
// visible 5-second jumps.
const LYRIC_TICK_MS = 200;
let pollTimer = null;
let lyricClockTimer = null;
let currentTrackId = null;
let currentLyricLines; // undefined = still fetching · null = confirmed no lyrics · array = loaded
let syncedProgressMs = 0;   // progress as of the last successful poll
let syncedAtMs = 0;         // performance.now() when that poll's data was captured
let isPlayingNow = false;
let renderDeps = null; // { el, esc, openSettings-like helper } injected from app.js

export function initMirror(deps) {
  renderDeps = deps;
}

async function spotifyFetch(path, options = {}) {
  const token = await getValidAccessToken();
  if (!token) {
    const err = new Error("Not connected to Spotify.");
    err.code = "reauth-required";
    throw err;
  }
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    disconnectSpotify();
    const err = new Error("Spotify rejected the access token.");
    err.code = "reauth-required";
    throw err;
  }
  return res;
}

async function fetchNowPlaying() {
  const requestStartedAt = performance.now();
  const res = await spotifyFetch("/me/player/currently-playing");
  if (res.status === 204) return { playing: false };
  if (!res.ok) throw new Error(`Spotify HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.item) return { playing: false };
  // Spotify's progress_ms reflects where playback was WHEN THEIR SERVER
  // processed the request, not when we finish receiving the response. On a
  // slower connection that gap is exactly the "lyrics feel a beat behind"
  // sensation — correcting for it here means every consumer of progressMs
  // gets an already-compensated value, not just the lyric line.
  const roundTripMs = performance.now() - requestStartedAt;
  return {
    playing: !!json.is_playing,
    trackId: json.item.id,
    track: json.item.name,
    artist: (json.item.artists || []).map((a) => a.name).join(", "),
    primaryArtist: json.item.artists?.[0]?.name || "",
    album: json.item.album?.name || "",
    image: json.item.album?.images?.[0]?.url || null,
    progressMs: (json.progress_ms || 0) + roundTripMs,
    durationMs: json.item.duration_ms || 0,
  };
}

// Playback controls are best-effort: they need Premium AND an active
// device, neither of which this app can guarantee. A failure here is
// reported inline rather than thrown, so one missing device doesn't take
// the whole tab down.
async function control(action) {
  const map = {
    playpause: (isPlaying) => ({ path: "/me/player/" + (isPlaying ? "pause" : "play"), method: "PUT" }),
    next: () => ({ path: "/me/player/next", method: "POST" }),
    previous: () => ({ path: "/me/player/previous", method: "POST" }),
  };
  return map[action];
}

export function renderMirror(root) {
  const { el, esc } = renderDeps;
  root.innerHTML = "";

  completeSpotifyLoginIfRedirected().then((result) => {
    if (result.handled) renderMirror(root); // re-render once the redirect round-trip resolves
  }).catch((err) => {
    console.error(err);
    root.appendChild(el(`<p class="status bad">Login check failed: ${esc(err.message)}</p>`));
  });

  const hasClientId = !!getSpotifyConfig()?.clientId;
  const connected = isSpotifyConnected();

  // Anything unexpected here — a bad selector, a storage read failing in
  // an unusual way, anything not already anticipated — now becomes a
  // visible red line instead of an uncaught exception that leaves the tab
  // blank with no trace. On a phone there's no console to catch this any
  // other way.
  try {
    if (!hasClientId) {
      root.appendChild(setupPrompt(root, "clientId"));
      return;
    }
    if (!connected) {
      root.appendChild(setupPrompt(root, "connect"));
      return;
    }

    root.appendChild(el(`
      <div class="mirror-stage">
        <p class="whisper">Mirror</p>
        <div id="mirror-body"><p class="footnote">Checking what's playing…</p></div>
      </div>
    `));
    startPolling(root.querySelector("#mirror-body"));
  } catch (err) {
    console.error(err);
    root.appendChild(el(`<p class="status bad">Something broke: ${esc(err.message)}</p>`));
  }
}

function setupPrompt(root, stage) {
  const { el } = renderDeps;

  if (stage === "clientId") {
    const wrap = el(`
      <div class="stage-empty">
        <p class="whisper">Mirror</p>
        <p class="lede">See what's playing, as it plays.</p>
        <p class="footnote">
          Needs a free Spotify app registration — takes about a minute, no
          coding. Go to developer.spotify.com/dashboard, create an app, and
          add this exact address as a Redirect URI:
        </p>
        <p class="footnote" id="mirror-redirect-uri" style="font-family:var(--mono);word-break:break-all"></p>
        <div class="field"><label>Client ID</label><input id="mirror-client-id" type="text" placeholder="from the Spotify dashboard" /></div>
        <p class="status" id="mirror-setup-status"></p>
        <div class="act-row" style="padding-left:0;padding-right:0">
          <button class="plain-act" id="mirror-save-client-id">Continue</button>
        </div>
      </div>
    `);
    wrap.querySelector("#mirror-redirect-uri").textContent = location.origin + location.pathname;
    wrap.querySelector("#mirror-save-client-id").addEventListener("click", () => {
      const id = wrap.querySelector("#mirror-client-id").value.trim();
      const status = wrap.querySelector("#mirror-setup-status");
      if (!id) { status.textContent = "Paste the Client ID first."; status.className = "status bad"; return; }
      saveSpotifyConfig({ clientId: id });
      renderMirror(root);
    });
    return wrap;
  }

  const wrap = el(`
    <div class="stage-empty">
      <p class="whisper">Mirror</p>
      <p class="lede">One more step.</p>
      <p class="footnote">Log in with Spotify to see what's playing.</p>
      <div class="act-row" style="padding-left:0;padding-right:0">
        <button class="plain-act" id="mirror-connect">Connect Spotify</button>
      </div>
    </div>
  `);
  wrap.querySelector("#mirror-connect").addEventListener("click", () => {
    beginSpotifyLogin().catch((err) => console.error(err));
  });
  return wrap;
}

function startPolling(body) {
  stopPolling();
  const tick = async () => {
    if (document.hidden) return; // paused while the tab/app isn't visible
    try {
      const state = await fetchNowPlaying();
      // Re-anchor the local clock on every successful poll — this is what
      // keeps it correct across seeks, pauses, and any drift, rather than
      // letting the interpolation wander further off with each cycle.
      syncedProgressMs = state.progressMs;
      syncedAtMs = performance.now();
      isPlayingNow = state.playing;
      await renderNowPlaying(body, state);
      setPollStatus(body, null); // clear any previous error once something succeeds
    } catch (err) {
      console.warn("Mirror poll failed:", err.message);
      if (err.code === "reauth-required") {
        stopPolling();
        const panel = body.closest(".mirror-stage")?.parentElement;
        renderMirror(panel || body.parentElement || body);
        return;
      }
      // Anything else (network hiccup, rate limit, unexpected response) is
      // shown right on the tab rather than only logged — this app is used
      // exclusively on a phone, where the console is never actually seen.
      setPollStatus(body, err.message);
    }
  };
  tick();
  pollTimer = setInterval(tick, POLL_MS);
  startLyricClock(body);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function setPollStatus(body, message) {
  const { el } = renderDeps;
  const stage = body.closest(".mirror-stage");
  if (!stage) return;
  let status = stage.querySelector("#mirror-poll-status");
  if (!message) { status?.remove(); return; }
  if (!status) {
    status = el(`<p class="status bad" id="mirror-poll-status"></p>`);
    stage.appendChild(status);
  }
  status.textContent = message;
}

// Where the track SHOULD be right now, extrapolated from the last poll
// using wall-clock time — not from the last poll's number alone, which
// would only ever change once every POLL_MS.
function estimateProgressMs() {
  if (!isPlayingNow) return syncedProgressMs;
  return syncedProgressMs + (performance.now() - syncedAtMs);
}

function startLyricClock(body) {
  stopLyricClock();
  lyricClockTimer = setInterval(() => {
    if (document.hidden || !isPlayingNow) return;
    updateLyricLine(body, estimateProgressMs());
  }, LYRIC_TICK_MS);
}

function stopLyricClock() {
  if (lyricClockTimer) clearInterval(lyricClockTimer);
  lyricClockTimer = null;
}

function onVisibilityChange() {
  if (!document.hidden && pollTimer) {
    // Fire immediately on return instead of waiting up to POLL_MS.
    const body = document.getElementById("mirror-body");
    if (body) startPolling(body);
  }
}

export function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  stopLyricClock();
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

async function renderNowPlaying(body, state) {
  const { el, esc } = renderDeps;

  if (!state.playing) {
    currentTrackId = null;
    body.innerHTML = "";
    body.appendChild(el(`<p class="footnote">Nothing playing right now.</p>`));
    return;
  }

  if (state.trackId !== currentTrackId) {
    currentTrackId = state.trackId;
    currentLyricLines = undefined;
    body.innerHTML = "";
    body.appendChild(el(`
      <div class="mirror-now">
        <div class="mirror-art ${state.image ? "" : "is-empty"}"></div>
        <div class="mirror-line" id="mirror-line"></div>
        <div class="mirror-track">
          <span class="mirror-track-name">${esc(state.track)}</span>
          <span class="mirror-track-artist"> — ${esc(state.artist)}</span>
        </div>
        <div class="mirror-progress"><div class="mirror-progress-fill" id="mirror-progress-fill"></div></div>
        <div class="mirror-controls">
          <button class="plain-act" data-a="previous">Prev</button>
          <button class="plain-act" data-a="playpause">Pause</button>
          <button class="plain-act" data-a="next">Next</button>
        </div>
        <p class="status" id="mirror-control-status"></p>
      </div>
    `));
    if (state.image) body.querySelector(".mirror-art").style.backgroundImage = `url("${state.image.replace(/"/g, "%22")}")`;
    wireControls(body, state);

    getSyncedLyrics({ artist: state.primaryArtist, track: state.track, album: state.album, durationSec: state.durationMs / 1000 })
      .then(({ lines }) => { currentLyricLines = lines; updateLyricLine(body, state.progressMs); });
  }

  const fill = body.querySelector("#mirror-progress-fill");
  if (fill && state.durationMs) fill.style.width = `${Math.min(100, (state.progressMs / state.durationMs) * 100)}%`;

  const playBtn = body.querySelector('[data-a="playpause"]');
  if (playBtn) playBtn.textContent = state.playing ? "Pause" : "Play";

  updateLyricLine(body, state.progressMs);
}

function updateLyricLine(body, progressMs) {
  const { el, esc } = renderDeps;
  const host = body.querySelector("#mirror-line");
  if (!host) return;

  let text = null;
  let emptyMessage = ""; // still fetching, or before the first lyric — nothing wrong, say nothing
  if (currentLyricLines === null) {
    emptyMessage = "No synced lyrics for this one."; // confirmed miss, worth saying
  } else if (Array.isArray(currentLyricLines)) {
    text = currentLine(currentLyricLines, progressMs);
  }

  // The clock calls this up to 5x/second; most of those calls land between
  // line changes, where there's nothing to actually update. Comparing
  // against what's already shown avoids rebuilding the DOM node — and the
  // CSS fade — for no visible change.
  const key = text ?? `\u0000${emptyMessage}`;
  if (host.dataset.lyricText === key) return;

  const node = text
    ? el(`<p class="lede mirror-lyric">${esc(text)}</p>`)
    : el(`<p class="lede mirror-lyric is-empty">${esc(emptyMessage)}</p>`);
  node.dataset.lyricText = key;
  host.replaceWith(node);
  node.id = "mirror-line";
}

function wireControls(body, state) {
  const status = body.querySelector("#mirror-control-status");
  body.querySelectorAll("[data-a]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.a;
      status.textContent = "";
      try {
        const build = await control(action);
        const { path, method } = build(state.playing);
        const res = await spotifyFetch(path, { method });
        if (res.status === 404) {
          status.textContent = "No active Spotify device — open Spotify somewhere first.";
          status.className = "status bad";
        } else if (res.status === 403) {
          status.textContent = "Playback control needs Spotify Premium.";
          status.className = "status bad";
        } else if (!res.ok && res.status !== 204) {
          status.textContent = `Couldn't do that (HTTP ${res.status}).`;
          status.className = "status bad";
        }
      } catch (err) {
        status.textContent = err.message;
        status.className = "status bad";
      }
    });
  });
}