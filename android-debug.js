// android-debug.js
//
// Phase 1B-2 proof surface. Deliberately a SEPARATE page from Mirror:
// mirror.js still starts only startSpotifyProvider(), and no arbitration
// exists yet. This page proves independently that the Android state arrives
// intact -- which is the whole objective of 1B-2.

import { startAndroidProvider, stopAndroidProvider } from "./android-listening-provider.js";
import { getReadSecret, saveReadSecret, clearReadSecret } from "./relay-config.js";

const el = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));

const secretBox = document.getElementById("secret-box");
const stateBox = document.getElementById("state-box");
const logBox = document.getElementById("log-box");
const lines = [];

function log(msg) {
  lines.unshift(`${new Date().toISOString().slice(11, 23)}  ${msg}`);
  logBox.textContent = lines.slice(0, 25).join("\n");
}

function row(label, value) {
  return `<div class="row"><span class="k">${esc(label)}</span><span class="v">${esc(value ?? "null")}</span></div>`;
}

function renderSecret() {
  const has = !!getReadSecret();
  secretBox.innerHTML = has
    ? `<p>Read secret: <b>configured</b></p><button id="clear-secret">Clear</button>`
    : `<p>Paste the READ secret (starts with <code>lmr_</code>):</p>
       <input id="secret-input" type="password" placeholder="lmr_..." />
       <button id="save-secret">Save</button>`;
  document.getElementById("save-secret")?.addEventListener("click", () => {
    const v = document.getElementById("secret-input").value.trim();
    if (!v) return;
    saveReadSecret(v);
    renderSecret();
    restart();
  });
  document.getElementById("clear-secret")?.addEventListener("click", () => {
    clearReadSecret(); renderSecret(); stopAndroidProvider(); stateBox.innerHTML = "<p>stopped</p>";
  });
}

function renderState(state) {
  if (!state) {
    stateBox.innerHTML = `<p class="none">state: null &mdash; nothing playing on Android, or state expired</p>`;
    return;
  }
  stateBox.innerHTML =
    row("source", state.source) + row("artist", state.artist) + row("primaryArtist", state.primaryArtist) +
    row("track", state.track) + row("album", state.album) + row("artwork", state.artwork) +
    row("isPlaying", state.isPlaying) + row("durationMs", state.durationMs) +
    row("positionMs (compensated)", state.positionMs) + row("externalId", state.externalId) +
    row("externalUrl", state.externalUrl) + row("confidence", state.confidence) +
    row("capturedAt", state.capturedAt) + row("controlsSupported", state.controlsSupported);
}

function restart() {
  stopAndroidProvider();
  if (!getReadSecret()) return;
  startAndroidProvider({
    onState: (s) => { renderState(s); log(s ? `state: ${s.source} / ${s.track} @ ${s.positionMs}ms` : "state: null"); },
    onError: (e) => log(`error: ${e.message}`),
  });
}

renderSecret();
restart();
