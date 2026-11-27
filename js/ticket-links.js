// ticket-links.js
//
// What a stored ticket link actually is. Discovery saves whatever "tickets"
// link a listing site offers; most of those are intermediaries (Podiuminfo,
// Festivalinfo), some are resale or affiliate links, and only a few point at
// the official seller itself. Shared by the browser (which purchase button to
// show) and the Actions scripts (which pages may be read and trusted).
//
// The registry is deliberately small: a host is listed as an official seller
// only after the live audit found it linked from a venue's own event page.

// Tracking parameters that never identify an event. Everything else in a
// query string (event IDs, shop or language selectors) is kept.
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|yclid|twclid|ttclid)$/i;

export function cleanTicketURL(value, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return null;
  }
}

const bare = hostname => hostname.toLowerCase().replace(/^www\./, '');

// Listing sites whose /ticket/ links are redirects to a seller chosen by the
// listing site. Their robots.txt (checked 2026-11-26) disallows /ticket/* for
// every agent, so automated resolution must never follow them.
export const TICKET_INTERMEDIARIES = [
  { id: 'podiuminfo', label: 'Podiuminfo', host: 'podiuminfo.nl', path: /^\/ticket\//, robots: 'Disallow: /ticket/*' },
  { id: 'festivalinfo', label: 'Festivalinfo', host: 'festivalinfo.nl', path: /^\/ticket\//, robots: 'Disallow: /ticket/*' }
];

// Secondary markets and affiliate redirects to them. Never official.
const RESALE = [
  { id: 'ticketswap', label: 'TicketSwap', match: url => /(^|\.)ticketswap\.(com|nl|be|de|fr|uk)$/.test(bare(url.hostname)) },
  { id: 'podiuminfo-ticketswap', label: 'TicketSwap via Podiuminfo', match: url => ['podiuminfo.nl', 'festivalinfo.nl'].includes(bare(url.hostname)) && /^\/ticketswap\//.test(url.pathname) },
  { id: 'viagogo', label: 'viagogo', match: url => /(^|\.)viagogo\.[a-z.]+$/.test(bare(url.hostname)) },
  { id: 'stubhub', label: 'StubHub', match: url => /(^|\.)stubhub\.[a-z.]+$/.test(bare(url.hostname)) },
  { id: 'ticketmaster-resale', label: 'Ticketmaster resale', match: url => /^ticketmaster\.(nl|be)$/.test(bare(url.hostname)) && /resale|doorverkoop/i.test(url.pathname + url.search) }
];

// Official sellers. `checkout` marks shop pages that are not themselves
// readable evidence (JavaScript shells, robots-disallowed): their link is a
// verified purchase destination, but prices come from the venue's page.
export const OFFICIAL_SELLERS = [
  { id: 'ticketmaster', label: 'Ticketmaster',
    match: url => /^ticketmaster\.(nl|be)$/.test(bare(url.hostname)) && /^\/(?:[a-z]{2}\/)?event\/[^/]+/.test(url.pathname) },
  { id: 'stager', label: 'Stager',
    match: url => /^[a-z0-9-]+\.stager\.co$/.test(url.hostname) && /^\/shop\/[^/]+\/events\/\d+\/?$/.test(url.pathname) },
  { id: 'paradiso-tickets', label: 'Paradiso', checkout: true,
    match: url => url.hostname === 'tickets.paradiso.nl' && /^\/[0-9a-f]{32}\/?$/i.test(url.pathname) },
  { id: '013-tickets', label: '013', checkout: true,
    match: url => url.hostname === 'tickets.013.nl' && /^\/[0-9a-f]{32}\/?$/i.test(url.pathname) },
  { id: 'parallel-tickets', label: 'Parallel', checkout: true,
    match: url => url.hostname === 'tickets.parallel.am' && /^\/[0-9a-f]{32}\/?$/i.test(url.pathname) },
  { id: 'doornroosje-tickets', label: 'Doornroosje', checkout: true,
    match: url => url.hostname === 'ticketshop.doornroosje.nl' && /^\/[0-9a-f]{32}\/?$/i.test(url.pathname) },
  { id: 'tivolivredenburg-tickets', label: 'TivoliVredenburg', checkout: true,
    match: url => url.hostname === 'ticket.tivolivredenburg.nl' && /^\/nl\/buyingflow\/tickets\/\d+\/\d+\/?$/.test(url.pathname) },
  { id: 'eventix', label: 'Eventix', checkout: true,
    match: url => ['shop.eventix.io', 'eventix.shop'].includes(url.hostname) && /^\/[0-9a-z-]{8,}\/?/i.test(url.pathname) },
  { id: 'paylogic', label: 'Paylogic', checkout: true,
    match: url => url.hostname === 'shop.paylogic.com' && /^\/[0-9a-f]{32}\/?/i.test(url.pathname) }
];

// Links on official pages that are never a purchase for this concert.
const NOT_A_PURCHASE = /\/(orders?|account|login|mijn|my-tickets|wachtwoord|password)(\/|$)/i;

export function classifyTicketLink(value, base) {
  const href = cleanTicketURL(value, base);
  if (!href) return { kind: 'invalid', url: null };
  const url = new URL(href);
  const host = bare(url.hostname);
  for (const item of RESALE) if (item.match(url)) return { kind: 'resale', provider: item.id, label: item.label, url: href };
  for (const item of TICKET_INTERMEDIARIES) {
    if (host === item.host && item.path.test(url.pathname)) {
      return { kind: 'intermediary', provider: item.id, label: item.label, url: href, robots: item.robots };
    }
  }
  if (NOT_A_PURCHASE.test(url.pathname)) return { kind: 'unrelated', url: href };
  for (const item of OFFICIAL_SELLERS) {
    if (item.match(url)) return { kind: 'official-seller', provider: item.id, label: item.label, url: href, checkout: !!item.checkout };
  }
  return { kind: 'unknown', url: href };
}

// The verified purchase destination saved for a concert, or null. The record
// must belong to the same concert identity; anything else is ignored.
export function verifiedSellerLink(record, concertIdentity) {
  const seller = record?.seller;
  if (!seller || record.identity !== concertIdentity || seller.identity !== concertIdentity
    || seller.status !== 'resolved') return null;
  const link = classifyTicketLink(seller.purchaseUrl);
  if (link.kind === 'official-seller') return { ...seller, purchaseUrl: link.url };
  // A venue event page that was itself verified for this concert (its buy
  // button is a script, or the venue names the seller without a link).
  if (seller.provider === 'venue-event-page' && link.kind === 'unknown' && link.url
    && link.url === cleanTicketURL(seller.eventPageUrl)) return { ...seller, purchaseUrl: link.url };
  return null;
}

// One line for the dashboard explaining where the seller information comes
// from, or why it is missing. Never claims more than the record says.
export function sellerSummary(record, concertIdentity, ticketUrl) {
  const verified = verifiedSellerLink(record, concertIdentity);
  if (verified) {
    const via = verified.method === 'direct' ? 'stored official link'
      : `verified ${new URL(verified.eventPageUrl ?? verified.purchaseUrl).hostname.replace(/^www\./, '')} page`;
    return { state: 'verified', seller: verified.seller, text: `${verified.seller} · via ${via}` };
  }
  const stored = classifyTicketLink(ticketUrl);
  const seller = record?.identity === concertIdentity && record?.seller?.identity === concertIdentity ? record.seller : null;
  const reasons = {
    blocked: 'the venue site blocks automated checks',
    'robots-disallowed': "the venue's robots policy does not allow checks",
    ambiguous: 'the venue page lists several different ticket shops',
    'unsupported-venue': 'no verified venue source for this venue',
    unresolved: 'no matching official event page found'
  };
  const reason = seller ? reasons[seller.status] ?? 'not yet resolved' : 'not yet checked';
  const link = stored.kind === 'intermediary' ? ` The ${stored.label} link is not followed (robots policy).`
    : stored.kind === 'resale' ? ' The stored link is a resale market.' : '';
  return { state: seller ? 'unresolved' : 'unchecked', seller: null, text: `Official seller not verified: ${reason}.${link}` };
}
