// official-ticket-sellers.mjs
//
// Resolve a planned concert's stored ticket link to the official seller.
//
// Most stored links are Podiuminfo or Festivalinfo /ticket/ redirects. Both
// sites disallow /ticket/* for every agent in robots.txt, so they are never
// followed. Instead the seller is found where the venue itself publishes it:
// the venue's (or its verified organizer's) event page, located with the
// existing concert schedule discovery and checked for artist, date, venue and
// city before any link on it is trusted. A link counts as the official seller
// only when it is in the seller registry (js/ticket-links.js).
//
// Results are cached on the concert's record in data/official-ticket-offers.json
// under `seller`, keyed by concert identity, so later checks and the dashboard
// reuse a verified destination without re-reading pages.

import * as cheerio from 'cheerio';
import { classifyTicketLink, cleanTicketURL } from '../../js/ticket-links.js';
import { identity } from '../../js/ticketswap-matching.js';
import { parseSchedule, venueConfig } from './concert-schedule.mjs';
import { isOrganizer, parseZiggo, publisherConfigs, venueOnPage, ziggoAPI } from './schedule-providers.mjs';
import { PublisherBackoff, RobotsDisallowed } from './official-ticket-http.mjs';

export const SELLER_RESOLVED_TTL_MS = 7 * 86400000;
export const SELLER_RETRY_TTL_MS = 86400000;
export const SELLER_BLOCKED_TTL_MS = 3 * 86400000;

// Link texts on an event page that are not the ordinary ticket for the night.
const NOT_THE_TICKET = /\b(mijn tickets|my tickets|premium|vip|parkeer\w*|parking|upgrade|locker|garderobe|arrangement|hotel|merch\w*|cadeau\w*|gift ?card|resale|doorverkoop)\b/i;

const dutchCents = text => {
  const match = /€\s*(\d{1,4})(?:[,.](\d{2}))?(?!\d)/.exec(text);
  return match ? Number(match[1]) * 100 + Number(match[2] ?? 0) : null;
};

// The state a venue prints on its own ticket button. A plain "Tickets" link
// says nothing about stock, so it stays unknown.
export function buttonState(text) {
  // Button labels are often glued together ("WachtlijstTicket € 55,40").
  if (/(wachtlijst|waiting ?list)/i.test(text)) return 'waitlist';
  if (/(uitverkocht|sold ?out)/i.test(text)) return 'sold-out';
  return null;
}

// Official seller links in the page's main content, never navigation or
// footer links (account pages, parking, other nights).
export function sellerLinksOnPage(html, pageUrl) {
  const $ = cheerio.load(html);
  $('nav,header,footer,aside,[class*="related"],[class*="recommend"],[class*="footer"]').remove();
  const root = $('main').first().length ? $('main').first() : $('body');
  const links = new Map();
  root.find('a[href]').each((_, node) => {
    const text = $(node).text().replace(/\s+/g, ' ').trim().slice(0, 120);
    const link = classifyTicketLink($(node).attr('href'), pageUrl);
    if (link.kind !== 'official-seller' || NOT_THE_TICKET.test(text)) return;
    const previous = links.get(link.url);
    links.set(link.url, {
      url: link.url, provider: link.provider, label: link.label, checkout: link.checkout,
      text: previous?.text || text, priceCents: previous?.priceCents ?? dutchCents(text),
      state: previous?.state ?? buttonState(text)
    });
  });
  return [...links.values()];
}

// One seller destination, or null when the page offers several different
// ones (separate shows, packages) and none is clearly this night's ticket.
export function pickSeller(links) {
  if (links.length === 1) return links[0];
  const plain = links.filter(link => /^(koop )?(tickets?|kaarten|bestel( tickets)?|buy tickets)\b/i.test(link.text));
  return plain.length === 1 ? plain[0] : null;
}

// The event page must name this concert: artist and date (parseSchedule's
// identity rules), on the venue's own host, or on an organizer host that also
// names the venue.
export function verifiedEventPage(page, concert) {
  const config = venueConfig(concert);
  const hosts = publisherConfigs(concert, config).map(item => item[1]);
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  if (!hosts.includes(host)) return false;
  if (isOrganizer(concert, host, config) && !venueOnPage(page.html, concert)) return false;
  return !!parseSchedule(page.html, concert, page.url, 'official');
}

function storedEventPages(concert) {
  const config = venueConfig(concert);
  const hosts = publisherConfigs(concert, config).map(item => item[1]);
  return [...new Set([
    concert.officialEventUrl, concert.officialUrl,
    ...(concert.schedule?.sources ?? []).filter(source => source?.kind === 'official').map(source => source.url),
    ...(concert.scheduleSourceUrls ?? [])
  ].map(value => cleanTicketURL(value)).filter(url => url
    && hosts.includes(new URL(url).hostname.replace(/^www\./, ''))))];
}

const failure = (error) => error instanceof RobotsDisallowed ? 'robots-disallowed'
  : error instanceof PublisherBackoff ? (error.reason === 'access-control' ? 'access-control' : 'rate-limited')
  : 'unavailable';

/**
 * Resolve one concert. `reader` is createOfficialPageReader(): its
 * `fetchPage(url, hosts)` reads pages under robots and pacing rules, and
 * `robotsAllowed(url)` answers for an intermediary without fetching it.
 * `discover(concert, fetchPage)` returns candidate event URLs (the schedule
 * discovery); it is injected so tests stay offline.
 */
export async function resolveOfficialSeller({ concert, reader, discover, now = Date.now() }) {
  const key = identity(concert);
  const checkedAt = new Date(now).toISOString();
  const stored = classifyTicketLink(concert.ticketUrl);
  const base = { identity: key, ticketUrl: stored.url, ticketLink: stored.url ? stored.kind : 'none', checkedAt };

  if (stored.kind === 'official-seller') {
    return { ...base, status: 'resolved', method: 'direct', provider: stored.provider, seller: stored.label,
      purchaseUrl: stored.url, eventPageUrl: null, evidence: 'Stored ticket link is an official seller' };
  }
  const intermediary = stored.kind === 'intermediary' ? {
    provider: stored.provider, url: stored.url, traversed: false,
    reason: await reader.robotsAllowed(stored.url).then(allowed => allowed
      ? 'not-traversed: destination is chosen by the listing site'
      : `robots-disallowed (${stored.robots})`).catch(() => 'robots-unavailable')
  } : null;

  const config = venueConfig(concert);
  const hosts = publisherConfigs(concert, config).map(item => item[1]);
  if (!hosts.length) {
    return { ...base, intermediary, status: 'unsupported-venue', reason: 'No verified official publisher for this venue' };
  }

  const reasons = new Set();
  const seen = new Set();
  const tryPages = async urls => {
    for (const url of urls) {
      if (seen.has(url) || seen.size >= 4) continue;
      seen.add(url);
      let page;
      try {
        page = await reader.fetchPage(url, hosts);
      } catch (error) {
        reasons.add(failure(error));
        continue;
      }
      const host = new URL(page.url).hostname.replace(/^www\./, '');
      // Ziggo Dome's event page is client-rendered; its public agenda API
      // carries the identity and the seller.
      const api = host === 'ziggodome.nl' ? ziggoAPI(page.url) : null;
      if (api) {
        let payload = null;
        try {
          payload = JSON.parse((await reader.fetchPage(api, hosts)).html);
        } catch (error) {
          reasons.add(error instanceof SyntaxError ? 'identity-unverified' : failure(error));
          continue;
        }
        if (!parseZiggo(payload, concert, page.url, checkedAt)) {
          reasons.add('identity-unverified');
          continue;
        }
        const event = payload.data[0];
        const sales = classifyTicketLink(event.salesUrl);
        const named = typeof event.event?.seller === 'string' ? event.event.seller.trim().slice(0, 60) : '';
        return { ...base, intermediary, status: 'resolved', method: 'venue-event-page',
          provider: sales.kind === 'official-seller' ? sales.provider : 'venue-event-page',
          seller: sales.kind === 'official-seller' ? sales.label : named || 'Ziggo Dome',
          purchaseUrl: sales.kind === 'official-seller' ? sales.url : page.url, eventPageUrl: page.url,
          buttonState: null, buttonPriceCents: null,
          evidence: named ? `Ziggo Dome public event data names ${named} as seller` : 'Verified Ziggo Dome event data' };
      }
      if (!verifiedEventPage(page, concert)) {
        reasons.add('identity-unverified');
        continue;
      }
      const links = sellerLinksOnPage(page.html, page.url);
      const seller = pickSeller(links);
      if (seller) {
        return { ...base, intermediary, status: 'resolved', method: 'venue-event-page', provider: seller.provider,
          seller: seller.label, purchaseUrl: seller.url, eventPageUrl: page.url,
          buttonState: seller.state, buttonPriceCents: seller.priceCents,
          evidence: `Linked from the verified ${host} event page` };
      }
      if (links.length) {
        reasons.add('ambiguous-seller');
        continue;
      }
      // The verified official event page is itself the official destination
      // (its buy button is a script, or tickets are not on sale yet).
      return { ...base, intermediary, status: 'resolved', method: 'venue-event-page',
        provider: 'venue-event-page', seller: host, purchaseUrl: page.url, eventPageUrl: page.url,
        buttonState: null, buttonPriceCents: null,
        evidence: 'Verified official event page; no separate seller link is published on it' };
    }
    return null;
  };

  const known = await tryPages(storedEventPages(concert));
  if (known) return known;
  let found = [];
  try {
    const urls = await discover(concert, reader.fetchPage);
    for (const reason of urls.failures ?? []) reasons.add(reason);
    found = urls.map(url => cleanTicketURL(url)).filter(Boolean);
  } catch (error) {
    reasons.add(failure(error));
  }
  const resolved = await tryPages(found);
  if (resolved) return resolved;

  const status = reasons.has('access-control') ? 'blocked'
    : reasons.has('ambiguous-seller') ? 'ambiguous'
    : reasons.size && [...reasons].every(reason => reason === 'robots-disallowed') ? 'robots-disallowed' : 'unresolved';
  return { ...base, intermediary, status, reason: [...reasons].join(', ') || 'No official event page found' };
}

// Whether a cached seller record can be reused instead of resolving again.
export function sellerIsCurrent(record, concert, now = Date.now()) {
  const seller = record?.seller;
  if (!seller || seller.identity !== identity(concert)
    || seller.ticketUrl !== classifyTicketLink(concert.ticketUrl).url) return false;
  const age = now - Date.parse(seller.checkedAt);
  const ttl = seller.status === 'resolved' ? SELLER_RESOLVED_TTL_MS
    : seller.status === 'blocked' ? SELLER_BLOCKED_TTL_MS : SELLER_RETRY_TTL_MS;
  return age >= 0 && age < ttl;
}

// Event pages found by the existing schedule discovery for one concert.
export function scheduleDiscovery(enrichOne) {
  return async (concert, fetchPage) => {
    const schedule = await enrichOne(concert, new Date().toISOString(), 'manual', fetchPage);
    const attempts = schedule.discovery?.attempts ?? [];
    const urls = attempts.filter(attempt => /^verified/.test(attempt.status)).map(attempt => attempt.url);
    // Why discovery found nothing, for the audit report.
    urls.failures = [...new Set(attempts.filter(attempt => attempt.status === 'fetch-failed').map(attempt =>
      /robots policy/i.test(attempt.reason) ? 'robots-disallowed'
        : /access unavailable/i.test(attempt.reason) ? 'access-control'
        : /Unapproved/.test(attempt.reason) ? 'unapproved-host' : 'unavailable'))];
    if (attempts.some(attempt => attempt.status === 'identity-unverified' || attempt.status === 'venue-mismatch')) {
      urls.failures.push('identity-unverified');
    }
    return urls;
  };
}

