import { ticketSwapURL } from './ticketswap-matching.mjs';

function eurCents(price) {
  return price?.currency === 'EUR' && Number.isSafeInteger(price.amount) && price.amount >= 0
    ? price.amount : null;
}

function priceStats(prices) {
  if (!prices.length) return { low: null, high: null, median: null, listingsCounted: 0 };
  prices.sort((a, b) => a - b);
  const lowMiddle = prices[Math.floor((prices.length - 1) / 2)];
  const highMiddle = prices[Math.floor(prices.length / 2)];
  return {
    low: prices[0],
    high: prices.at(-1),
    median: lowMiddle + Math.round((highMiddle - lowMiddle) / 2),
    listingsCounted: prices.length
  };
}

function listingURL(value) {
  const safe = ticketSwapURL(value);
  const url = safe ? new URL(safe) : null;
  return url?.pathname.startsWith('/listing/') ? url.origin + url.pathname : null;
}

function offerDetails(listing, converted, buyerTotalCents) {
  const price = converted ? listing.converted_price : listing.price;
  const sellerCents = eurCents(price?.seller_price);
  const originalCents = eurCents(price?.original_price);
  return {
    buyerTotalCents,
    sellerCents,
    originalCents,
    feeDifferenceCents: sellerCents !== null && sellerCents <= buyerTotalCents
      ? buyerTotalCents - sellerCents : null,
    url: listingURL(listing.url)
  };
}

export function summarizeListings(data) {
  if (
    data?.listing_status !== 'AVAILABLE' ||
    !Array.isArray(data.listings) ||
    typeof data.page_info?.has_next_page !== 'boolean'
  ) {
    throw new Error('Unexpected TicketSwap listings response');
  }

  const seen = new Set();
  const prices = [];
  const categories = new Map();
  let availableTickets = 0;
  let activeListings = 0;
  let cheapest = null;
  let missingWatchLots = false;

  for (const listing of data.listings) {
    if (typeof listing?.id !== 'string' || !listing.id.trim()) throw new Error('Missing listing ID');
    if (listing.event?.id !== data.event_id) throw new Error('Listing belongs to a different event');
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);

    const count = listing.number_of_available_tickets;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid available ticket count');
    if (!count) continue;
    availableTickets += count;
    if (!Number.isSafeInteger(availableTickets)) throw new Error('Invalid total available ticket count');
    activeListings++;

    const type = listing.ticket_type;
    const id = typeof type?.id === 'string' && type.id.trim() ? type.id : null;
    const title = typeof type?.title === 'string' && type.title.trim()
      ? type.title.trim().slice(0, 160) : null;
    const category = categories.get(id) ?? { id, title: null, availableTickets: 0, activeListings: 0, prices: [], watchLots: new Map() };
    if (id) category.title ??= title;
    category.availableTickets += count;
    category.activeListings++;
    categories.set(id, category);

    const converted = listing.converted_price?.total_price != null;
    const price = eurCents(converted ? listing.converted_price.total_price : listing.price?.total_price);
    if (listing.number_of_tickets_in_listing === count) {
      const lot = category.watchLots.get(count) ?? { quantity: count, buyerCents: null, missingPrice: false };
      if (price === null) lot.missingPrice = true;
      else lot.buyerCents = lot.buyerCents === null ? price : Math.min(lot.buyerCents, price);
      category.watchLots.set(count, lot);
    } else {
      missingWatchLots = true;
    }
    if (price === null) continue;

    prices.push(price);
    category.prices.push(price);
    if (count === 1 && listing.number_of_tickets_in_listing === 1
      && (!category.singleTicketOffer || price < category.singleTicketOffer.buyerTotalCents)) {
      category.singleTicketOffer = { buyerTotalCents: price, url: listingURL(listing.url) };
    }
    if (!cheapest || price < cheapest.buyerTotalCents) {
      cheapest = offerDetails(listing, converted, price);
    }
  }

  const buyerPrices = priceStats(prices);
  return {
    availableTickets,
    lowestPriceCents: buyerPrices.low,
    currency: 'EUR',
    complete: !data.page_info.has_next_page,
    missingPrices: buyerPrices.listingsCounted < activeListings,
    market: {
      activeListings,
      watchLotsKnown: true,
      missingWatchLots,
      buyerPrices,
      cheapest,
      categories: [...categories.values()].map(({ prices, watchLots, ...category }) => ({
        ...category, buyerPrices: priceStats(prices), watchLots: [...watchLots.values()]
      }))
    }
  };
}

function observation(entry) {
  if (entry?.currency !== 'EUR' || !Number.isFinite(Date.parse(entry.checkedAt))
    || !Number.isSafeInteger(entry.availableTickets) || entry.availableTickets < 0) return null;
  return {
    checkedAt: entry.checkedAt,
    availableTickets: entry.availableTickets,
    lowestPriceCents: eurCents({ currency: entry.currency, amount: entry.lowestPriceCents }),
    medianPriceCents: entry.market?.buyerPrices.median ?? null,
    originalPriceCents: entry.market?.cheapest?.originalCents ?? null,
    complete: entry.complete === true,
    missingPrices: entry.missingPrices !== false
  };
}

export function recordMarketHistory(previous, current) {
  const observations = new Map();
  if (previous?.identity === current.identity && previous?.event?.id === current.event.id) {
    for (const point of previous.marketHistory ?? []) observations.set(point.checkedAt, point);
    const last = observation(previous);
    if (last) observations.set(last.checkedAt, last);
  }
  const point = observation(current);
  if (point) observations.set(point.checkedAt, point);
  return [...observations.values()].sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt)).slice(-24);
}
