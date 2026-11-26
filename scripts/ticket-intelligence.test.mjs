import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTicketMoney, parseTicketDemand, selectTicketEvidence, ticketHistory, ticketInsight } from '../js/ticket-intelligence-model.js';
import { identity } from '../js/ticketswap-matching.js';
const now = Date.parse('2026-11-26T13:00:00Z');
const time = new Date(now).toISOString();
const concert = { id: 'concert', artist: 'Example', date: '2027-02-20', venue: 'Hall', city: 'Utrecht', country: 'NL' };
const key = identity(concert);
const category = { id: 'ga', title: 'Standing', availableTickets: 4, activeListings: 1,
  buyerPrices: { low: 2400, listingsCounted: 1 }, singleTicketOffer: { buyerTotalCents: 2400 } };
const swap = { identity: key, status: 'ok', currency: 'EUR', lowestPriceCents: 2400, checkedAt: time, complete: true,
  availableTickets: 4, event: { id: 'event' }, market: { categories: [category] } };
const offer = { seller: 'Official', category: 'Standing', currency: 'EUR', finalCents: 3000,
  feeInclusive: true, availability: 'available', quantity: 1, resaleEventId: 'event', resaleTypeId: 'ga', verifiedAt: time };
const snapshot = (record, stale = false) => ({ data: { entries: { concert: record } }, stale });
const evidence = (resale = swap, official = offer, privateData = null) =>
  selectTicketEvidence(concert, snapshot(resale), snapshot({ identity: key, offers: [official] }), privateData, now);

test('only fresh, comparable all-in offers yield savings and market insights', () => {
  assert.equal(evidence().comparable.savingsCents, 600);
  assert.equal(evidence().comparable.savingsPercent, 20);
  assert.equal(ticketInsight(evidence())[0], 'Below official price');
  assert.equal(evidence(swap, { ...offer, feeInclusive: false, listedCents: 3000 }).comparable, null);
  assert.equal(evidence(swap, { ...offer, availability: 'sold-out' }).comparable, null);
  assert.equal(evidence(swap, { ...offer, resaleEventId: 'unrelated' }).comparable, null);
  assert.equal(evidence({ ...swap, status: 'error' }).comparable, null);
  assert.equal(formatTicketMoney(null), 'Unknown');
  assert.equal(formatTicketMoney(0), '€0.00');
});

test('history retains dated observations and missing-price gaps without mixing category or currency', () => {
  const gap = '2026-11-24T13:00:00Z';
  const first = '2026-11-22T13:00:00Z';
  const model = evidence({ ...swap, marketHistory: [
    { checkedAt: first, lowestPriceCents: 3000, complete: true },
    { checkedAt: gap, lowestPriceCents: null, complete: true },
    { checkedAt: 'invalid', lowestPriceCents: 3000, complete: true }
  ] });
  const [resale, official] = ticketHistory(model);
  assert.deepEqual(resale.points.map(point => point.cents), [3000, null, 2400]);
  assert.deepEqual(official.points.map(point => point.cents), [3000]);
  assert.deepEqual(ticketHistory(model, 'ga')[0].points.map(point => point.cents), [2400]);
  assert.deepEqual(ticketHistory(model, 'other').map(series => series.points.length), [0, 0]);
  assert.equal(ticketHistory(evidence(swap, { ...offer, currency: 'USD' }))[1].points.length, 0);
});

test('demand distinguishes identical units, preserves ambiguity, and ignores the wrong private event', () => {
  assert.deepEqual(parseTicketDemand('19 people waiting\n24 tickets wanted'), { people: 19, tickets: 24 });
  assert.deepEqual(parseTicketDemand('More than 19 people waiting', '24–40 tickets wanted'), { people: null, tickets: null });
  assert.deepEqual(parseTicketDemand('19 mensen op de wachtlijst', '20 people waiting'), { people: null, tickets: null });
  const demand = { eventId: 'wrong-event', title: '19 people waiting', checkedAt: time };
  assert.equal(evidence(swap, offer, { entries: { concert: { observation: swap, demand } } }).demand, null);
  assert.equal(evidence(swap, offer, { entries: { concert: {
    observation: swap, demand: { ...demand, eventId: 'event' }
  } } }).demand.title, demand.title);
});

test('opening with no public or private evidence yields a complete empty view model', () => {
  const model = selectTicketEvidence(concert, null, null, null, now);
  assert.equal(model.sold, null);
  assert.equal(model.offer, null);
  assert.equal(model.resale, null);
  assert.equal(ticketInsight(model)[0], 'Insufficient evidence');
  assert.deepEqual(ticketHistory(model).map(group => group.points), [[], []]);
});
