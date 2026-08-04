// spotify-auth.js
//
// Authorization Code Flow with PKCE. This is the flow Spotify designed
// specifically for apps with no server component — the app has nowhere
// safe to keep a client secret (this repo is public), so PKCE proves who's
// asking using a one-time cryptographic challenge instead of a fixed
// secret. Only a Client ID is needed, and it's meant to be public.
//
// Storage: tokens live in localStorage, same pattern as the GitHub
// connection. A refresh happens automatically whenever the stored access
// token is within 60 seconds of expiring.

const CONFIG_KEY = "lm_spotify_config";     // { clientId }
const TOKEN_KEY = "lm_spotify_tokens";      // { accessToken, refreshToken, expiresAt }
const VERIFIER_KEY = "lm_spotify_pkce_verifier"; // transient, only during the redirect round-trip

const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

export function getSpotifyConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || "null"); } catch { return null; }
}
export function saveSpotifyConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function getTokens() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null"); } catch { return null; }
}
function saveTokens(tokens) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

export function isSpotifyConnected() {
  return !!getTokens()?.refreshToken;
}

export function disconnectSpotify() {
  localStorage.removeItem(TOKEN_KEY);
}

// --- PKCE primitives -------------------------------------------------

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function base64UrlEncode(buffer) {
  let str = "";
  const bytes = new Uint8Array(buffer);
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  return crypto.subtle.digest("SHA-256", data);
}

// The redirect URI is wherever this page is hosted, with no query/hash —
// it has to match EXACTLY what's registered in the Spotify dashboard, and
// recomputing it the same way at both ends keeps that automatic.
function redirectUri() {
  return location.origin + location.pathname;
}

// --- Step 1: send the user to Spotify to log in ----------------------

export async function beginSpotifyLogin() {
  const config = getSpotifyConfig();
  if (!config?.clientId) throw new Error("No Spotify Client ID configured yet.");

  const verifier = randomString(64);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const challenge = base64UrlEncode(await sha256(verifier));

  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  // State round-trips through Spotify unchanged — used here only to
  // remember which app tab to return to, not as a security token (PKCE's
  // verifier already does that job).
  url.searchParams.set("state", "mirror");

  location.href = url.toString();
}

// --- Step 2: handle the redirect back from Spotify --------------------
//
// Called once at boot. If the URL carries ?code=..., this exchanges it for
// tokens and strips the query string so a page refresh can't replay a
// used, single-use code.

export async function completeSpotifyLoginIfRedirected() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");

  if (!code && !error) return { handled: false };

  params.delete("code");
  params.delete("state");
  params.delete("error");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));

  if (error) return { handled: true, ok: false, error };

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier) return { handled: true, ok: false, error: "Missing PKCE verifier (was the page reloaded mid-login?)" };

  const config = getSpotifyConfig();
  if (!config?.clientId) return { handled: true, ok: false, error: "No Spotify Client ID configured." };

  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        client_id: config.clientId,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Spotify token exchange failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    saveTokens({
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    return { handled: true, ok: true };
  } catch (err) {
    return { handled: true, ok: false, error: err.message };
  }
}

// --- Step 3: keep the access token fresh -------------------------------

async function refreshAccessToken() {
  const config = getSpotifyConfig();
  const tokens = getTokens();
  if (!config?.clientId || !tokens?.refreshToken) throw new Error("Not connected to Spotify.");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: config.clientId,
    }),
  });
  if (!res.ok) {
    // A refresh token can be revoked (e.g. the user removed the app's
    // access from their Spotify account) — treat that as "disconnected"
    // rather than retrying forever.
    if (res.status === 400 || res.status === 401) disconnectSpotify();
    throw new Error(`Spotify token refresh failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  saveTokens({
    accessToken: json.access_token,
    // Spotify doesn't always rotate the refresh token — keep the old one
    // if a new one wasn't issued.
    refreshToken: json.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
  });
  return json.access_token;
}

// The only function the rest of the app needs to call before hitting any
// Spotify Web API endpoint.
export async function getValidAccessToken() {
  const tokens = getTokens();
  if (!tokens?.refreshToken) return null;
  const expiringSoon = !tokens.expiresAt || Date.now() > tokens.expiresAt - 60000;
  if (!expiringSoon) return tokens.accessToken;
  return refreshAccessToken();
}
