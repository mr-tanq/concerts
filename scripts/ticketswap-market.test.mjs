import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeListings, recordMarketHistory } from './lib/ticketswap-summary.mjs';
import { checkConcert, identity } from './lib/ticketswap-going.mjs';

const euro = amount => ({ currency: 'EUR', amount });
const concert = {
  artist: 'Example', date: '2027-02-20', venue: 'Examplehouse',
  city: 'Utrecht', country: 'NL'
};
const event = { id: 'event', date: concert.date, url: 'https://www.ticketswap.com/event/example' };
const observed = (date, overrides = {}) => ({
  identity: identity(concert), event, currency: 'EUR', checkedAt: date,
  availableTickets: 2, lowestPriceCents: 2100, complete: true, missingPrices: false, ...overrides
});
const listing = (id, price, fields = {}) => ({
  id, event: { id: event.id }, number_of_available_tickets: 2,
  ticket_type: { id: 'general', title: 'General admission' },
  price: { total_price: euro(price) }, ...fields
});
const response = (listings, partial = false) => ({
  event_id: event.id, listing_status: 'AVAILABLE', listings,
  page_info: { has_next_page: partial }
});

test('market stats are per listing and preserve partial coverage and unknown categories', () => {
  const ga = listing('a', 3800, { number_of_available_tickets: 4 });
  const balcony = listing('b', 2600, { ticket_type: { id: 'balcony', title: 'Balcony' } });
  const unknown = listing('c', null, { ticket_type: { title: 'Unverified' } });
  const soldOut = listing('d', 1, { number_of_available_tickets: 0 });
  const summary = summarizeListings(response([ga, ga, balcony, unknown, soldOut], true));
  assert.equal(summary.complete, false);
  assert.equal(summary.missingPrices, true);
  assert.equal(summary.availableTickets, 8);
  assert.equal(summary.market.activeListings, 3);
  assert.deepEqual(summary.market.buyerPrices, { low: 2600, high: 3800, median: 3200, listingsCounted: 2 });
  assert.deepEqual(summary.market.categories.map(category => [
    category.title, category.availableTickets, category.buyerPrices.median
  ]), [['General admission', 4, 3800], ['Balcony', 2, 2600], [null, 2, null]]);
});

test('cheapest offer emits a safe link and compatible EUR price components only', () => {
  const raw = listing('a', 1900, {
    url: 'https://www.ticketswap.com/listing/example/abc?tracking=private#section',
    converted_price: {
      total_price: euro(2000), seller_price: euro(1700),
      original_price: { currency: 'USD', amount: 1500 }
    },
    price: { original_price: euro(1600), seller_price: euro(1800), total_price: euro(1900) }
  });
  const { cheapest } = summarizeListings(response([raw])).market;
  assert.deepEqual(cheapest, {
    buyerTotalCents: 2000, sellerCents: 1700, originalCents: null,
    feeDifferenceCents: 300, url: 'https://www.ticketswap.com/listing/example/abc'
  });
  const invalid = summarizeListings(response([listing('b', 1000, {
    url: 'https://ticketswap.com.evil.test/listing/example/abc',
    price: { total_price: euro(1000), seller_price: euro(2000), original_price: euro(0) }
  })])).market.cheapest;
  assert.equal(invalid.url, null);
  assert.equal(invalid.feeDifferenceCents, null);
  assert.equal(invalid.originalCents, 0);
});

test('checks keep real history, preserve failed attempts, and retain gaps without prices', async () => {
  const first = observed('2026-11-01T10:00:00.000Z');
  const nextTime = new Date('2026-11-02T10:00:00Z');
  const next = await checkConcert(concert, first, async () => response([]), nextTime);
  assert.deepEqual(next.marketHistory.map(p => [p.checkedAt, p.lowestPriceCents, p.availableTickets]), [
    [first.checkedAt, 2100, 2], [nextTime.toISOString(), null, 0]
  ]);
  assert.equal(next.marketHistory[0].medianPriceCents, null);
  const failure = await checkConcert(concert, next, async () => { throw new Error('Offline'); },
    new Date('2026-11-03T10:00:00Z'));
  assert.equal(failure.status, 'error');
  assert.deepEqual(failure.marketHistory, next.marketHistory);
  assert.equal(failure.checkedAt, next.checkedAt);
});

test('market history is bounded, deduplicated by observation time, and scoped to event and identity', () => {
  let previous;
  for (let day = 1; day <= 26; day++) {
    const current = observed(new Date(Date.UTC(2026, 10, day)).toISOString());
    previous = { ...current, marketHistory: recordMarketHistory(previous, current) };
  }
  assert.equal(previous.marketHistory.length, 24);
  assert.match(previous.marketHistory[0].checkedAt, /11-03/);
  const current = { ...previous, lowestPriceCents: 1900 };
  assert.equal(recordMarketHistory(previous, current).at(-1).lowestPriceCents, 1900);
  assert.equal(recordMarketHistory(previous, current).length, 24);
  assert.equal(recordMarketHistory(previous, { ...current, event: { id: 'different' } }).length, 1);
  assert.equal(recordMarketHistory(previous, { ...current, identity: 'different' }).length, 1);
});
