// ambient-control.js
//
// Mirror's small "ambient recognition" remote: one button in the Mirror
// header that asks the Android Companion to switch ambient (radio) song
// recognition ON or OFF, plus a status dot.
//
// Uses Mirror's EXISTING relay read secret for both status and commands —
// there is no separate control credential. Android uses its write secret to
// poll for commands and acknowledge them.
//
// Owned by mirror.js: mounted when the Mirror stage is drawn, stopped when
// Mirror stops polling (tab left), so nothing runs while Mirror is closed.

import { RELAY_URL, RELAY_ANON_KEY, getReadSecret } from "./relay-config.js";

const CONTROL_POLL_MS = 3000;

let button = null;
let pollTimer = null;
let busy = false;
let readInFlight = false;
let statusVersion = 0;
let last = null;

// An older build kept a separate pairing secret; it is unused now.
try { localStorage.removeItem("lm_ambient_control_secret"); } catch {}

async function rpc(name, body) {
  const res = await fetch(`${RELAY_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: RELAY_ANON_KEY,
      Authorization: `Bearer ${RELAY_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ambient control HTTP ${res.status}`);
  return res.json();
}

function secret() {
  const s = getReadSecret();
  if (!s) throw new Error("Relay read secret is not configured.");
  return s;
}

async function fetchStatus() {
  const result = await rpc("read_ambient_control_status", { p_secret: secret() });
  if (!result?.ok) throw new Error(result?.reason || "Ambient status rejected.");
  return result;
}

// state → one of: off · on · pending-on · pending-off · error
function render(state, error = null) {
  if (!button?.isConnected) return;
  let mode, title, pressed;
  if (error) {
    mode = "error"; title = error; pressed = button.getAttribute("aria-pressed") === "true";
  } else if (!state || !state.present) {
    mode = "off"; title = "Ambient remote · OFF"; pressed = false;
  } else {
    const desired = state.desired_enabled === true;
    const acked = state.ack_sequence === state.command_sequence && state.ack_enabled === desired;
    pressed = desired;
    if (desired && acked) { mode = "on"; title = "Ambient remote · ON"; }
    else if (desired) { mode = "pending-on"; title = "Ambient remote · ON requested"; }
    else if (acked) { mode = "off"; title = "Ambient remote · OFF"; }
    else { mode = "pending-off"; title = "Ambient remote · OFF requested"; }
  }
  button.dataset.state = mode;
  button.title = title;
  button.setAttribute("aria-pressed", String(pressed));
}

function activeAndVisible() {
  return button?.isConnected && !document.hidden;
}

async function readStatus() {
  if (!activeAndVisible() || busy || readInFlight) return;
  readInFlight = true;
  const version = statusVersion;
  try {
    const result = await fetchStatus();
    if (version !== statusVersion || !activeAndVisible()) return;
    last = result;
    render(result);
  } catch (err) {
    if (version !== statusVersion || !activeAndVisible()) return;
    render(last, err?.message || "Ambient control unavailable.");
  } finally {
    readInFlight = false;
  }
}

async function toggle() {
  if (busy) return;
  busy = true;
  statusVersion++;
  button.classList.add("is-busy");
  try {
    // Always ask the relay first instead of trusting cached state, so a
    // tap is exactly "flip whatever is true right now".
    const current = await fetchStatus();
    const next = !(current.present === true && current.desired_enabled === true);
    const result = await rpc("set_ambient_control", { p_secret: secret(), p_enabled: next });
    if (!result?.ok) throw new Error(result?.reason || "Ambient command rejected.");
    last = { ...result, present: true };
    render(last);
    // The Android acknowledgement is asynchronous.
    setTimeout(readStatus, 800);
    setTimeout(readStatus, 1800);
  } catch (err) {
    render(last, err?.message || "Ambient control failed.");
  } finally {
    busy = false;
    button?.classList.remove("is-busy");
  }
}

function onVisibility() {
  if (!document.hidden) readStatus();
}

export function mountAmbientControl(stage) {
  stopAmbientControl();
  if (!getReadSecret()) return;
  button = document.createElement("button");
  button.type = "button";
  button.className = "ambient-control";
  button.setAttribute("aria-label", "Ambient recognition");
  button.innerHTML = `
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 6l10-3"></path>
      <rect x="4" y="7" width="16" height="12" rx="2.4"></rect>
      <path d="M7.5 11h3.3M7.5 14h3.3M7.5 17h2.2"></path>
      <circle cx="15.6" cy="13.1" r="2.35"></circle>
    </svg>
    <span class="ambient-control-dot"></span>`;
  button.addEventListener("click", toggle);
  stage.appendChild(button);
  render(last);
  readStatus();
  pollTimer = setInterval(readStatus, CONTROL_POLL_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

export function stopAmbientControl() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  statusVersion++;
  document.removeEventListener("visibilitychange", onVisibility);
  button = null;
}
