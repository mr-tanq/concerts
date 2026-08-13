// mirror.js
//
// The "what's playing right now" tab. Shows the current lyric line in the
// app's existing editorial voice (the same big serif used for archive
// statements elsewhere — a lyric line IS that kind of sentence), and
// stays completely quiet the rest of the time.
//
// As of Phase 1A, the listening-state and rendering pipeline below no
// longer knows Spotify's response shape at all — it consumes a generic
// CurrentListeningState from whichever provider is active (today, only
// spotify-listening-provider.js exists). Mirror still directly owns
// Spotify setup/auth (setupPrompt, beginSpotifyLogin) and still calls
// Spotify's playback-control functions directly when the active state
// says controlsSupported — those two things are legitimately
// Spotify-specific today and aren't part of the generic contract.
// Artist, track, artwork, isPlaying, durationMs, positionMs, source,
// controlsSupported: a future source publishing that same shape needs no
// changes to the rendering pipeline below.

import {
  getSpotifyConfig, saveSpotifyConfig, isSpotifyConnected,
  beginSpotifyLogin, completeSpotifyLoginIfRedirected,
} from "./spotify-auth.js";
import {
  spotifyPlayPause, spotifyNext, spotifyPrevious,
} from "./spotify-listening-provider.js";
import {
  startListeningProvider, stopListeningProvider,
} from "./listening-source-provider.js";
import { getReadSecret } from "./relay-config.js";
import { identityKeyFor, isValidPlaybackNumber } from "./listening-state.js";
import { getSyncedLyrics, currentLine } from "./lyrics.js";

// How often the lyric line re-checks itself against elapsed time. The
// active provider is only asked for a fresh state occasionally (5s for
// Spotify's poll, whatever cadence a future push source uses) — this
// just interpolates between those answers using the browser's own clock,
// the same technique any lyric-sync player uses, so the line changes
// when it should instead of in visible jumps.
const LYRIC_TICK_MS = 200;
let lyricClockTimer = null;
let currentIdentityKey = null;
let currentLyricLines; // undefined = still fetching · null = confirmed no lyrics · array = loaded
let syncedProgressMs = 0;   // position as of the last state update
let syncedAtMs = 0;         // performance.now() when that update was captured
// Whether syncedProgressMs is currently trustworthy to extrapolate from —
// kept separate from the raw number itself. A number staying numerically
// "valid" is not the same as it being the CURRENT track's real position;
// this flag is what stops a stale number from a previous track quietly
// continuing to answer estimateProgressMs() after a track change.
let hasReliablePosition = false;
let isPlayingNow = false;
let renderDeps = null; // { el, esc } injected from app.js

export function initMirror(deps) {
  renderDeps = deps;
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

  // Phase 1C: Spotify is no longer a precondition for Mirror. Android/
  // YouTube must work with Spotify disconnected entirely, so the setup
  // screen only appears when NEITHER source is available.
  const spotifyAvailable = !!getSpotifyConfig()?.clientId && isSpotifyConnected();
  const androidAvailable = !!getReadSecret();

  // Anything unexpected here — a bad selector, a storage read failing in
  // an unusual way, anything not already anticipated — now becomes a
  // visible red line instead of an uncaught exception that leaves the tab
  // blank with no trace. On a phone there's no console to catch this any
  // other way.
  try {
    if (!spotifyAvailable && !androidAvailable) {
      // Neither path configured -- fall back to the original Spotify
      // onboarding, since that's still the primary source we'd want set up.
      const stage = !getSpotifyConfig()?.clientId ? "clientId" : "connect";
      root.appendChild(setupPrompt(root, stage));
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

// ---------- provider wiring ----------
//
// Mirror doesn't poll anything itself — it asks the active provider to
// start, and receives a generic CurrentListeningState (or null) through
// onState whenever one is available. Today the only provider is Spotify's
// own 5-second poll; a future push-based provider calls the exact same
// onState callback on its own schedule, and none of the code below needs
// to change to accept it.

// Resets everything Mirror's OWN rendering pipeline remembers about
// "what was last shown" — deliberately separate from the provider's own
// generation/session concept (provider restart and Mirror-view reset are
// different lifecycles). Without this, leaving and returning to the
// Mirror tab recreates the DOM but leaves currentIdentityKey pointing at
// whatever track was last shown; if the provider's very first new state
// still reports that SAME track, the "is this a new track" comparison
// sees no change and never rebuilds the just-wiped DOM, leaving the
// screen stuck on "Checking what's playing…" until the track changes.
function resetMirrorSession() {
  currentIdentityKey = null;
  currentLyricLines = undefined;
  syncedProgressMs = 0;
  syncedAtMs = 0;
  hasReliablePosition = false;
  isPlayingNow = false;
  missingPollStreak = 0;
}

function startPolling(body) {
  resetMirrorSession();
  stopPolling();
  startListeningProvider({
    enableSpotify: !!getSpotifyConfig()?.clientId && isSpotifyConnected(),
    enableAndroid: !!getReadSecret(),
    onState: (state) => handleListeningState(body, state),
    onError: (err) => handleProviderError(body, err),
  });
  startLyricClock(body);
}

function handleProviderError(body, err) {
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

// Where the track SHOULD be right now, extrapolated from the last known
// state using wall-clock time. Returns null when there's no reliable
// anchor to extrapolate FROM — this never synthesizes a number that
// merely LOOKS valid by carrying a previous track's position forward
// under a different track's identity.
function estimateProgressMs() {
  if (!hasReliablePosition) return null;
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

// The provider owns its own visibility handling (an immediate re-check on
// tab return) — the lyric clock already no-ops while hidden and resumes
// correctly on its own via the document.hidden check in its own tick, so
// Mirror doesn't need a second visibility listener duplicating that.
export function stopPolling() {
  stopListeningProvider();
  stopLyricClock();
}

// A state reporting "nothing" immediately after a Pause tap is a known
// Spotify quirk on some clients/devices, not necessarily the truth — the
// track is very likely just paused. Tolerating a couple of consecutive
// misses before actually clearing the screen avoids the track vanishing
// the instant you pause it, while still correctly clearing after a real
// stop (closing Spotify, switching to a podcast with no track, etc.).
const MAX_TOLERATED_MISSES = 2;
let missingPollStreak = 0;

async function handleListeningState(body, state) {
  const { el, esc } = renderDeps;
  // Any successful state — even "nothing playing" — means the provider
  // has recovered from whatever transient error was last shown, if any.
  setPollStatus(body, null);

  if (!state) {
    if (currentIdentityKey && missingPollStreak < MAX_TOLERATED_MISSES) {
      missingPollStreak++;
      return; // keep showing the last known track a little longer
    }
    missingPollStreak = 0;
    currentIdentityKey = null;
    currentLyricLines = undefined;
    hasReliablePosition = false;
    isPlayingNow = false;
    syncedProgressMs = 0;
    body.innerHTML = "";
    body.appendChild(el(`<p class="footnote">Nothing playing right now.</p>`));
    return;
  }
  missingPollStreak = 0;

  // Re-anchor the local clock on every successful state — this is what
  // keeps it correct across seeks, pauses, and any drift, rather than
  // letting the interpolation wander further off with each cycle. When
  // this state's position isn't trustworthy, hasReliablePosition is
  // explicitly dropped to false — critically, this happens even if a
  // numerically "valid-looking" syncedProgressMs is still sitting there
  // from a previous track, so that stale number can never quietly keep
  // answering estimateProgressMs() under a new track's identity.
  if (isValidPlaybackNumber(state.positionMs)) {
    syncedProgressMs = state.positionMs;
    hasReliablePosition = true;
  } else {
    hasReliablePosition = false;
  }
  syncedAtMs = performance.now();
  isPlayingNow = state.isPlaying;

  const key = identityKeyFor(state);
  if (key !== currentIdentityKey) {
    currentIdentityKey = key;
    currentLyricLines = undefined;
    body.innerHTML = "";
    body.appendChild(el(`
      <div class="mirror-now">
        <div class="mirror-art ${state.artwork ? "" : "is-empty"}"></div>
        <div class="mirror-line" id="mirror-line"></div>
        <div class="mirror-track">
          <span class="mirror-track-name">${esc(state.track)}</span>
          <span class="mirror-track-artist"> — ${esc(state.artist)}</span>
        </div>
        <div class="mirror-progress"><div class="mirror-progress-fill" id="mirror-progress-fill"></div></div>
        ${state.controlsSupported ? `
        <div class="mirror-controls">
          <button class="plain-act" data-a="previous">Prev</button>
          <button class="plain-act" data-a="playpause">Pause</button>
          <button class="plain-act" data-a="next">Next</button>
        </div>
        <p class="status" id="mirror-control-status"></p>` : ""}
      </div>
    `));
    if (state.artwork) body.querySelector(".mirror-art").style.backgroundImage = `url("${state.artwork.replace(/"/g, "%22")}")`;
    if (state.controlsSupported) wireControls(body);

    // The existing lyrics lookup has always searched on the primary
    // (first-credited) artist alone, not the joined display string —
    // preserved exactly via state.primaryArtist rather than state.artist.
    const requestKey = key; // which track identity started this lookup
    getSyncedLyrics({
      artist: state.primaryArtist || state.artist,
      track: state.track,
      album: state.album,
      durationSec: isValidPlaybackNumber(state.durationMs) ? state.durationMs / 1000 : undefined,
    }).then(({ lines }) => {
      // Discard if a different track is active by the time this resolves.
      // Without this, a slow response for a track the person has since
      // moved past can arrive AFTER a faster response for the current
      // one and silently overwrite it with the wrong lyrics.
      if (requestKey !== currentIdentityKey) return;
      currentLyricLines = lines;
      // The CURRENT playback anchor, not the position captured when this
      // request started — the track's identity may still match, but the
      // position itself can be seconds stale by now (a seek, a pause, or
      // simply the normal passage of time while lrclib was still loading).
      updateLyricLine(body, estimateProgressMs());
    });
  }

  const fill = body.querySelector("#mirror-progress-fill");
  if (fill && isValidPlaybackNumber(state.durationMs) && state.durationMs > 0 && isValidPlaybackNumber(state.positionMs)) {
    fill.style.width = `${Math.min(100, (state.positionMs / state.durationMs) * 100)}%`;
  }

  const playBtn = body.querySelector('[data-a="playpause"]');
  if (playBtn && playBtn.dataset.pending !== "true") playBtn.textContent = state.isPlaying ? "Pause" : "Play";

  updateLyricLine(body, state.positionMs);
}

function updateLyricLine(body, progressMs) {
  const { el, esc } = renderDeps;
  const host = body.querySelector("#mirror-line");
  if (!host) return;

  // lyrics.js's currentLine() has no way to distinguish "position
  // unknown" from "position zero" — it just compares numbers, and an
  // invalid position makes that comparison silently wrong (undefined
  // returns the LAST line; null returns the FIRST; NaN/negative/Infinity
  // are untested and no more trustworthy). The guard has to live here,
  // before ever calling it, for any source that can't report a reliable
  // position. Inert for Spotify today, since it always provides a valid
  // finite non-negative number. Zero itself is explicitly valid — a
  // track that just started is not the same as an unknown position.
  if (!isValidPlaybackNumber(progressMs)) return;

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

function wireControls(body) {
  const status = body.querySelector("#mirror-control-status");

  body.querySelector('[data-a="playpause"]')?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    status.textContent = "";
    const wasPlaying = isPlayingNow;

    // Captured BEFORE isPlayingNow changes. estimateProgressMs() reads
    // isPlayingNow to decide whether to add elapsed time since the last
    // anchor — computing it AFTER the flip meant a pause silently lost
    // the seconds since the last update (estimateProgressMs saw
    // isPlayingNow already false and returned the stale anchor instead
    // of extrapolating), while a resume added the entire paused
    // duration as though playback had continued through it.
    const estimated = estimateProgressMs();

    isPlayingNow = !wasPlaying;
    btn.textContent = isPlayingNow ? "Pause" : "Play";
    btn.dataset.pending = "true";
    // estimateProgressMs() can legitimately return null when there's no
    // reliable anchor yet — in that case there's nothing to re-anchor
    // to, so syncedProgressMs (and hasReliablePosition) are left exactly
    // as they were rather than being overwritten with a null.
    if (estimated != null) syncedProgressMs = estimated;
    syncedAtMs = performance.now();

    try {
      const res = await spotifyPlayPause(wasPlaying);
      if (res.status === 404) {
        status.textContent = "No active Spotify device — open Spotify somewhere first.";
        status.className = "status bad";
        isPlayingNow = wasPlaying; // revert the guess
        btn.textContent = wasPlaying ? "Pause" : "Play";
      } else if (res.status === 403) {
        status.textContent = "Playback control needs Spotify Premium.";
        status.className = "status bad";
        isPlayingNow = wasPlaying;
        btn.textContent = wasPlaying ? "Pause" : "Play";
      } else if (!res.ok && res.status !== 204) {
        status.textContent = `Couldn't do that (HTTP ${res.status}).`;
        status.className = "status bad";
        isPlayingNow = wasPlaying;
        btn.textContent = wasPlaying ? "Pause" : "Play";
      }
    } catch (err) {
      status.textContent = err.message;
      status.className = "status bad";
      isPlayingNow = wasPlaying;
      btn.textContent = wasPlaying ? "Pause" : "Play";
    } finally {
      btn.dataset.pending = "false";
    }
  });

  body.querySelectorAll('[data-a="previous"], [data-a="next"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      status.textContent = "";
      try {
        const res = btn.dataset.a === "next" ? await spotifyNext() : await spotifyPrevious();
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
