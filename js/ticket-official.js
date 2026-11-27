import { classifyTicketLink, cleanTicketURL, verifiedSellerLink } from './ticket-links.js';
import { identity } from './ticketswap-matching.js';

export const OFFER_MAX_AGE_MS = 6 * 3600000;

// An https link with tracking parameters removed; event and shop parameters stay.
export function ticketSourceURL(value) {
  try {
    if (new URL(value).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return cleanTicketURL(value);
}

// The purchase link to offer when no fresh official offer names one: a
// verified seller destination first, then a stored link that is itself an
// official seller. Intermediary, resale and unknown links are never offered
// as "Official tickets".
export function knownOfficialLink(concert, record) {
  const verified = verifiedSellerLink(record, identity(concert));
  if (verified) return verified.purchaseUrl;
  for (const value of [concert.ticketUrl, concert.officialUrl, concert.sourceUrl]) {
    const safe = ticketSourceURL(value);
    if (!safe) continue;
    const link = classifyTicketLink(safe);
    if (link.kind === 'official-seller') return link.url;
    const url = new URL(safe);
    if (/^(www\.)?ticketmaster\.(de|fr|co\.uk|com)$/.test(url.hostname)
      && /(?:^|\/)event\/[^/]+/.test(url.pathname)) return safe;
  }
  const fallback = ticketSourceURL(concert.officialUrl)
    || (concert.source === 'official' ? ticketSourceURL(concert.sourceUrl) : null);
  return fallback && !['intermediary', 'resale'].includes(classifyTicketLink(fallback).kind) ? fallback : null;
}

export function offerIsFresh(value, now = Date.now()) {
  const age = now - Date.parse(value);
  return age >= 0 && age <= OFFER_MAX_AGE_MS;
}

const cents = amount => Number.isSafeInteger(amount) && amount >= 0;

export function getOfficialComparison(offer, resale, now = Date.now()) {
  if (!offerIsFresh(offer.verifiedAt, now) || resale?.status !== 'ok'
    || !offerIsFresh(resale.checkedAt, now)
    || !offer.resaleTypeId || offer.resaleEventId !== resale.event?.id
    || offer.quantity !== 1 || offer.availability !== 'available' || !offer.feeInclusive
    || resale.currency !== 'EUR' || offer.currency !== resale.currency || !cents(offer.finalCents) || offer.finalCents === 0) {
    return null;
  }

  const category = resale.market?.categories?.find(item => item.id === offer.resaleTypeId);
  const buyerCents = category?.singleTicketOffer?.buyerTotalCents;
  if (!(category?.availableTickets > 0) || !cents(buyerCents)) return null;
  const savingsCents = offer.finalCents - buyerCents;
  return {
    buyerCents,
    listingUrl: category.singleTicketOffer.url,
    savingsCents,
    savingsPercent: savingsCents / offer.finalCents * 100,
    sampled: !resale.complete || resale.missingPrices || buyerCents !== category.buyerPrices.low
  };
}

export function offerWasSuperseded(offer, offers) {
  return offers.some(other => !other.sourceFailed && other.availability !== 'unknown'
    && other.category === offer.category
    && (other.seller === offer.seller || other.purchaseUrl === offer.purchaseUrl)
    && Date.parse(other.verifiedAt) > Date.parse(offer.verifiedAt));
}

export function watchOfficialComparison(record, resale, categoryId, now = Date.now()) {
  if (!resale || record?.identity !== resale.identity) return null;
  const offers = [...(record.offers ?? []), ...Object.values(record.providerChecks ?? {})
    .filter(check => check.status === 'verified').flatMap(check => check.offers)];
  for (const offer of offers) {
    if ((categoryId && offer.resaleTypeId !== categoryId) || offerWasSuperseded(offer, offers)) continue;
    const result = getOfficialComparison(offer, resale, now);
    if (result) return { ...result, category: offer.category, seller: offer.seller,
      purchaseUrl: offer.purchaseUrl, verifiedAt: offer.verifiedAt };
  }
  return null;
}
