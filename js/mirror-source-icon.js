// mirror-source-icon.js
//
// The small provenance mark in front of Mirror's track line: which app the
// song is coming from (Spotify, YouTube / YouTube Music, ambient radio
// recognition). Decorative only — driven by the `source` field the
// listening providers already put on every state, so it costs no extra
// network calls.

const SPOTIFY = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.2"></circle><path d="M7.1 9.4c3.5-1 7.2-.7 9.9.8"></path><path d="M7.8 12.4c2.9-.7 5.9-.45 8.2.6"></path><path d="M8.5 15.1c2.2-.5 4.5-.3 6.4.4"></path></svg>`;
const YOUTUBE = `<svg width="16" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" aria-hidden="true"><rect x="3.5" y="6.5" width="17" height="11" rx="3.2"></rect><path d="M10 9.5l5 3-5 3z" fill="currentColor" stroke="none"></path></svg>`;
const RADIO = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 6l10-3"></path><rect x="4" y="7" width="16" height="12" rx="2.4"></rect><path d="M7.5 11h3.3M7.5 14h3.3M7.5 17h2.2"></path><circle cx="15.6" cy="13.1" r="2.35"></circle></svg>`;

export function sourceIconFor(source) {
  switch (source) {
    case "spotify":
    case "spotify_web":
    case "spotify_android":
      return { label: "Spotify", svg: SPOTIFY };
    case "youtube_android":
      return { label: "YouTube", svg: YOUTUBE };
    case "youtube_music_android":
      return { label: "YouTube Music", svg: YOUTUBE };
    case "ambient_audd":
      return { label: "Ambient · radio", svg: RADIO };
    default:
      return null;
  }
}

export function renderSourceIcon(trackRow, source) {
  if (!trackRow) return;
  let host = trackRow.querySelector(".mirror-source-indicator");
  const icon = sourceIconFor(source);
  if (!icon) { host?.remove(); return; }
  if (!host) {
    host = document.createElement("span");
    host.className = "mirror-source-indicator";
    trackRow.prepend(host);
  }
  if (host.dataset.source === source) return;
  host.dataset.source = source;
  host.title = icon.label;
  host.setAttribute("aria-label", icon.label);
  host.setAttribute("role", "img");
  host.innerHTML = icon.svg;
}
