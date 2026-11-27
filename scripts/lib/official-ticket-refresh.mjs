import { identity } from '../../js/ticketswap-matching.js';
import { PublisherBackoff } from '../sources/official-ticket-http.mjs';
import { officialTicketSources, parseOfficialTicketPage } from '../sources/official-ticket-providers.mjs';
import { sellerIsCurrent } from '../sources/official-ticket-sellers.mjs';

// One compact price observation per seller/category per check, so verified
// official prices build a history across checks (the provider checks
// themselves are replaced each time).
const HISTORY_LIMIT = 120;
function observations(checks) {
  return Object.values(checks).filter(check => check.status === 'verified').flatMap(check => check.offers)
    .filter(offer => offer.currency && [offer.listedCents, offer.finalCents].some(Number.isSafeInteger))
    .map(offer => ({
      at: offer.verifiedAt, seller: offer.seller, category: offer.category, currency: offer.currency,
      listedCents: offer.listedCents ?? null, baseCents: offer.baseCents ?? null, feesCents: offer.feesCents ?? null,
      finalCents: offer.feeInclusive === true ? offer.finalCents : null, feeInclusive: offer.feeInclusive === true,
      serviceFeesIncluded: offer.priceContext?.serviceFeesIncluded === true,
      availability: offer.availability, sourceUrl: offer.sourceUrl
    }));
}
function mergeHistory(previous, added) {
  const key = item => [item.at, item.seller, item.category].join('\u0000');
  const rows = new Map((Array.isArray(previous) ? previous : []).map(item => [key(item), item]));
  for (const item of added) rows.set(key(item), item);
  return [...rows.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-HISTORY_LIMIT);
}

function mapped(offer, checks, mappings, concert, resale) {
  if (!offer.offerKey || checks.filter(item => item.offerKey === offer.offerKey).length !== 1
    || !resale?.event?.id || resale.identity !== identity(concert)) return offer;
  const matches = mappings.filter(item => item?.concertId === concert.id && item.identity === resale.identity
    && item.sourceUrl === offer.sourceUrl && item.offerKey === offer.offerKey && item.category === offer.category
    && item.resaleEventId === resale.event.id && typeof item.equivalenceEvidence === 'string'
    && item.equivalenceEvidence.trim() && item.equivalenceEvidence.length <= 240
    && resale.market?.categories?.some(category => category.id === item.resaleTypeId));
  if (matches.length !== 1) return offer;
  const { resaleEventId, resaleTypeId, equivalenceEvidence } = matches[0];
  return { ...offer, resaleEventId, resaleTypeId, equivalenceEvidence };
}

export async function refreshOfficialTickets({
  store, concert, resale, mappings = [], readPage, resolveSeller = null, now = Date.now()
}) {
  if (store?.version !== 1 || !store.entries || typeof store.entries !== 'object' || Array.isArray(store.entries)) {
    throw new Error('Invalid official ticket store');
  }
  const concertIdentity = identity(concert);
  const record = Object.hasOwn(store.entries, concert.id) && store.entries[concert.id]?.identity === concertIdentity
    ? store.entries[concert.id] : { identity: concertIdentity, offers: [] };
  let seller = record.seller?.identity === concertIdentity ? record.seller : null;
  let sellerChanged = false;
  if (resolveSeller && !sellerIsCurrent(record, concert, now)) {
    try {
      seller = await resolveSeller(concert);
      sellerChanged = true;
    } catch {
      // A failed resolution keeps the previous verified destination.
    }
  }
  const sources = officialTicketSources(concert, seller);
  if (!sources.length) {
    if (!sellerChanged) return { store, status: 'unsupported', sources: 0 };
    return { status: 'unsupported', sources: 0, store: {
      ...store, updatedAt: new Date(Math.max(now, Date.parse(store.updatedAt) || 0)).toISOString(),
      entries: { ...store.entries, [concert.id]: { ...record, seller } }
    } };
  }
  const checks = {};
  const backoff = { ...store.providerBackoff };
  for (const source of sources) {
    const previous = record.providerChecks?.[source.url];
    const age = now - Date.parse(previous?.attemptedAt);
    const ttl = previous?.status === 'verified' ? 3600000 : 15 * 60000;
    let check = previous;
    if (backoff[source.domain] > now) {
      check = previous ?? { attemptedAt: new Date(now).toISOString(), status: 'failed', offers: [] };
    } else if (!(age >= 0 && age < ttl)) {
      let offers = [];
      let status;
      try {
        const page = await readPage(source);
        offers = parseOfficialTicketPage(page.html, concert, { ...source, url: page.url }, page.observedAt);
        status = offers.length ? 'verified' : 'unsupported';
      } catch (error) {
        if (error instanceof PublisherBackoff) backoff[source.domain] = error.retryAt;
        offers = previous?.offers ?? [];
        status = 'failed';
      }
      check = { attemptedAt: new Date(now).toISOString(), status, offers };
    }
    checks[source.url] = {
      ...check,
      offers: check.offers.map(offer => mapped({
        ...offer, resaleEventId: null, resaleTypeId: null, equivalenceEvidence: null
      }, check.offers, mappings, concert, resale))
    };
  }
  const updated = { ...record, ...(seller ? { seller } : {}), providerChecks: checks };
  const history = mergeHistory(record.history, observations(checks));
  if (history.length) updated.history = history;
  if (JSON.stringify(record) === JSON.stringify(updated)) return { store, status: 'cached', sources: sources.length };
  return {
    status: Object.values(checks).some(check => check.status === 'verified') ? 'verified'
      : Object.values(checks).some(check => check.status === 'failed') ? 'unavailable' : 'unsupported',
    sources: sources.length,
    store: {
      ...store, providerBackoff: Object.fromEntries(Object.entries(backoff).filter(([, retryAt]) => retryAt > now)),
      updatedAt: new Date(Math.max(now, Date.parse(store.updatedAt) || 0)).toISOString(),
      entries: { ...store.entries, [concert.id]: updated }
    }
  };
}
