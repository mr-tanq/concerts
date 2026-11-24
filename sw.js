// sw.js — Listening Mirror service worker.
//
// Network-first for everything this site serves. While online, every request
// goes to the network and revalidates against the server (so a deploy shows
// up on the next load — no more stale js/identity.js after an update, whatever
// its ?v= string). The last good copy is kept only as an offline fallback, so
// the archive still opens with no signal.
//
// Cross-origin calls (GitHub API, Supabase relay, Spotify, Last.fm, fonts)
// are never touched: they pass straight through to the browser.

const CACHE = "lm-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isPage = req.mode === "navigate";
  // One offline copy of the page, keyed without its query string (the
  // Spotify login lands here with ?code=… and that must not be stored).
  const pageKey = new URL("./", self.location).href;

  event.respondWith((async () => {
    try {
      // "no-cache" = always revalidate with the server (cheap 304 when
      // unchanged), never the browser's heuristic HTTP cache. A navigation
      // request can't be re-issued with options, so it's rebuilt from its URL.
      const fresh = isPage
        ? await fetch(new Request(req.url, { cache: "no-cache", credentials: "same-origin" }))
        : await fetch(req, { cache: req.cache === "no-store" ? "no-store" : "no-cache" });
      if (fresh.ok && fresh.type === "basic") {
        const copy = fresh.clone();
        caches.open(CACHE).then((c) => c.put(isPage ? pageKey : req, copy)).catch(() => {});
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(isPage ? pageKey : req);
      if (cached) return cached;
      throw err;
    }
  })());
});
