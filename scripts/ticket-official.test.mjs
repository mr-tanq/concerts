import test from 'node:test';
import assert from 'node:assert/strict';
import { recordOfficialOffer } from './record-official-offer.mjs';
import { getOfficialComparison, knownOfficialLink, OFFER_MAX_AGE_MS } from '../js/ticket-official.js';
import { identity } from '../js/ticketswap-matching.js';
import { summarizeListings } from './lib/ticketswap-summary.mjs';

const now = Date.parse('2026-11-26T16:00:00Z');
const stamp = new Date(now - 60000).toISOString();
const concert = { id: 'planned-1', artist: 'Example', date: '2027-02-20',
  venue: 'Examplehouse', city: 'Utrecht', country: 'NL' };
const sourceUrl = 'https://www.ticketmaster.nl/event/example/123';
const input = {
  concertId: concert.id, seller: 'Ticketmaster', category: 'General admission',
  sourceUrl, purchaseUrl: sourceUrl, verifiedAt: stamp, evidence: 'Checkout total for one adult',
  quantity: 1, availability: 'available', currency: 'EUR', faceCents: 2100, baseCents: 2250,
  feesCents: 250, finalCents: 2500, feeInclusive: true, resaleTypeId: 'ga',
  equivalenceEvidence: 'Same general admission standing access for this date'
};
const listing = (id, total, quantity) => ({
  id, event: { id: 'event' }, ticket_type: { id: 'ga', title: 'GA' },
  url: 'https://www.ticketswap.com/listing/example/' + id,
  number_of_available_tickets: quantity, number_of_tickets_in_listing: quantity,
  price: { total_price: { amount: total, currency: 'EUR' } }
});
const market = summarizeListings({
  event_id: 'event', listing_status: 'AVAILABLE', page_info: { has_next_page: false },
  listings: [listing('lot', 1700, 2), listing('one', 2000, 1)]
});
const resale = { ...market, status: 'ok', event: { id: 'event' }, checkedAt: stamp, identity: identity(concert) };
const empty = { version: 1, entries: {} };

test('verified buyer totals compare an equivalent single-ticket listing and show signed savings', () => {
  const result = recordOfficialOffer(empty, concert, resale, input, now);
  const [offer] = result.entries[concert.id].offers;
  assert.deepEqual(getOfficialComparison(offer, resale, now), {
    buyerCents: 2000, listingUrl: 'https://www.ticketswap.com/listing/example/one',
    savingsCents: 500, savingsPercent: 20, sampled: true
  });
  assert.equal(getOfficialComparison({ ...offer, finalCents: 1800 }, resale, now).savingsCents, -200);
  assert.equal(getOfficialComparison({ ...offer, finalCents: 2000 }, resale, now).savingsPercent, 0);
});

test('unknown fees, availability, wrong currency or category, stale quotes or missing lot sizes block comparison', () => {
  const [offer] = recordOfficialOffer(empty, concert, resale, input, now).entries[concert.id].offers;
  for (const change of [
    { feeInclusive: false }, { finalCents: null }, { availability: 'sold-out' },
    { availability: 'unknown' }, { currency: 'GBP' }, { resaleTypeId: 'balcony' },
    { resaleEventId: 'different' }, { quantity: 2 }, { verifiedAt: new Date(now + 1).toISOString() },
    { verifiedAt: new Date(now - OFFER_MAX_AGE_MS - 1).toISOString() }
  ]) assert.equal(getOfficialComparison({ ...offer, ...change }, resale, now), null);
  for (const change of [
    { status: 'error' }, { checkedAt: '2026-11-01T00:00:00Z' }, { market: undefined },
    { market: { categories: [{ ...market.market.categories[0], singleTicketOffer: undefined }] } }
  ]) assert.equal(getOfficialComparison(offer, { ...resale, ...change }, now), null);
});

test('recording verifies identity and fee totals and prevents replacing newer evidence with older evidence', () => {
  for (const change of [
    { feesCents: 201 }, { feeInclusive: false }, { finalCents: 2500.1 }, { resaleTypeId: 'other' },
    { equivalenceEvidence: null }, { sourceUrl: 'http://ticketmaster.nl/' }, { quantity: 2 }
  ]) assert.throws(() => recordOfficialOffer(empty, concert, resale, { ...input, ...change }, now));
  const saved = recordOfficialOffer(empty, concert, resale, input, now);
  assert.throws(() => recordOfficialOffer(saved, concert, resale, { ...input, verifiedAt: '2026-11-25T00:00:00Z' }, now), /newer verification/);
  assert.throws(() => recordOfficialOffer(empty, { ...concert, city: 'Other' }, resale, input, now), /must exist/);
  const withoutPrice = { ...input, availability: 'unknown', feesCents: null, finalCents: null, feeInclusive: false };
  assert.equal(recordOfficialOffer(saved, concert, resale, withoutPrice, now).entries[concert.id].offers[0].availability, 'unknown');
});

test('official link fallback reuses venue provenance or an exact Ticketmaster event host', () => {
  assert.equal(knownOfficialLink({ ticketUrl: sourceUrl + '?utm_source=x&utm_campaign=y' }), sourceUrl);
  assert.equal(knownOfficialLink({ officialUrl: 'https://www.013.nl/programma/example' }), 'https://www.013.nl/programma/example');
  assert.equal(knownOfficialLink({ ticketUrl: 'https://www.podiuminfo.nl/ticket/example' }), null);
  assert.equal(knownOfficialLink({ ticketUrl: 'https://www.ticketmaster.nl.example.org/event/x' }), null);
});
