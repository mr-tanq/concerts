import * as cheerio from "cheerio";
import { allowedURL, matchName } from "./concert-schedule.mjs";

// Listings are shared between checks at the same venue during one run.
const caches = new WeakMap();
export async function discoverSchedulePages(concert, config, fetcher, visitEvent) {
  const host = config[1], hosts = [host];
  let cache = caches.get(fetcher.cacheKey || fetcher);
  if (!cache) { cache = new Map(); caches.set(fetcher.cacheKey || fetcher, cache); }
  const read = url => {
    if (!cache.has(url)) cache.set(url, Promise.resolve().then(() => fetcher(url, hosts)));
    return cache.get(url);
  };
  const safe = (raw, base) => {
    try {
      const url = new URL(raw, base);
      url.hash = "";
      // Some official sitemap generators still emit http links. Upgrade them;
      // requests themselves always remain HTTPS and on approved hosts.
      if (url.protocol === "http:") url.protocol = "https:";
      return allowedURL(url.href, hosts);
    } catch { return null; }
  };
  const seenEvents = new Set();
  async function checkLinks($, base, selector) {
    const links = [];
    $(selector).each((_, n) => {
      const raw = $(n).attr("href") || $(n).text().trim();
      const url = safe(raw, base);
      if (!url || url === base || seenEvents.has(url)) return;
      let decoded; try { decoded = decodeURIComponent(url); } catch { return; }
      if (matchName($(n).text() + " " + decoded, concert.artist)) links.push(url);
    });
    const dateInURL = url => url.includes(concert.date)
      || url.includes(concert.date.split("-").reverse().join("-"));
    links.sort((a, b) => Number(dateInURL(b)) - Number(dateInURL(a)));
    for (const url of new Set(links)) {
      if (seenEvents.size >= 8) break;
      seenEvents.add(url);
      if (await visitEvent(url)) return true;
    }
    return false;
  }

  const agendaURL = new URL(config[2], `https://${host}`);
  // MOJO's public agenda form accepts an artist/location query.
  if (host === "mojo.nl") agendaURL.searchParams.set("query", concert.artist);
  const agenda = agendaURL.href;
  const listings = [agenda], seenListings = new Set();
  while (listings.length && seenListings.size < 8) {
    const url = listings.shift();
    if (seenListings.has(url)) continue;
    seenListings.add(url);
    try {
      const page = await read(url);
      const base = safe(page.url, url);
      if (!base) continue;
      const $ = cheerio.load(page.html);
      if (await checkLinks($, base, "a[href]")) return true;
      $('a[rel~="next"],link[rel~="next"],.pagination a[href],.nav-links a[href],a.page-numbers[href]').each((_, n) => {
        const next = safe($(n).attr("href"), base);
        if (next && new URL(next).pathname.startsWith(new URL(agenda).pathname)
          && !seenListings.has(next) && !listings.includes(next)) listings.push(next);
      });
      // Also cover agendas whose load-more button hides numbered pages.
      if (url === agenda && (host === "tivolivredenburg.nl" || /wp-content|wp-json/.test(page.html))) {
        for (let number = 2; number <= 8; number++) {
          const next = new URL(agenda);
          next.pathname = next.pathname.replace(/\/?$/, "/") + `page/${number}/`;
          if (!listings.includes(next.href)) listings.push(next.href);
        }
      }
    } catch { /* Continue with another listing or sitemap. */ }
  }

  const maps = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"]
    .map(p => `https://${host}${p}`);
  const seenMaps = new Set();
  while (maps.length && seenMaps.size < 8) {
    const url = maps.shift();
    if (seenMaps.has(url)) continue;
    seenMaps.add(url);
    try {
      const page = await read(url);
      const base = safe(page.url, url);
      if (!base) continue;
      const $ = cheerio.load(page.html, { xmlMode: true });
      if (await checkLinks($, base, "url > loc")) return true;
      const children = [];
      $("sitemap > loc").each((_, n) => {
        const child = safe($(n).text().trim(), base);
        if (child && !seenMaps.has(child) && !maps.includes(child)) children.push(child);
      });
      // Production feeds contain current concert URLs; taxonomy maps do not.
      const rank = url => /archiv|categor|genre|venue.room/i.test(url) ? 0
        : /production/i.test(url) ? 3 : /event|agenda|program/i.test(url) ? 2 : 1;
      children.sort((a, b) => rank(b) - rank(a));
      maps.unshift(...children);
    } catch { /* A missing sitemap does not invalidate other sources. */ }
  }
  return false;
}
