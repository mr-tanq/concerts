export const OFFER_MAX_AGE_MS = 6 * 3600000;

export function ticketSourceURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return null;
  }
}

export function knownOfficialLink(concert) {
  for (const value of [concert.ticketUrl, concert.officialUrl, concert.sourceUrl]) {
    const safe = ticketSourceURL(value);
    if (!safe) continue;
    const url = new URL(safe);
    if (/^(www\.)?ticketmaster\.(nl|be|de|fr|co\.uk|com)$/.test(url.hostname)
      && /(?:^|\/)event\/[^/]+/.test(url.pathname)) return safe;
  }
  return ticketSourceURL(concert.officialUrl)
    || (concert.source === 'official' ? ticketSourceURL(concert.sourceUrl) : null);
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
