import { identity } from '../../js/ticketswap-matching.js';
import { PublisherBackoff } from '../sources/official-ticket-http.mjs';
import { officialTicketSources, parseOfficialTicketPage } from '../sources/official-ticket-providers.mjs';

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
  store, concert, resale, mappings = [], readPage, now = Date.now()
}) {
  if (store?.version !== 1 || !store.entries || typeof store.entries !== 'object' || Array.isArray(store.entries)) {
    throw new Error('Invalid official ticket store');
  }
  const sources = officialTicketSources(concert);
  if (!sources.length) return { store, status: 'unsupported', sources: 0 };
  const concertIdentity = identity(concert);
  const record = Object.hasOwn(store.entries, concert.id) && store.entries[concert.id]?.identity === concertIdentity
    ? store.entries[concert.id] : { identity: concertIdentity, offers: [] };
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
  const updated = { ...record, providerChecks: checks };
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
