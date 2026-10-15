import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConcert, identity } from './lib/ticketswap-going.mjs';
import { resolveTicketSwap } from './lib/ticketswap-matching.mjs';

const c = {
  artist: 'Example Band', date: '2027-02-20',
  venue: 'Examplehouse', city: 'Utrecht', country: 'NL'
};

const candidate = {
  id: 'chosen', name: 'A special event with Example Band',
  date: c.date, venue: c.venue, city: c.city, country: c.country,
  url: 'https://www.ticketswap.com/event/example'
};

const old = () => ({
  identity: identity(c),
  status: 'needs-review',
  matchCandidates: [{ ...candidate }]
});

const now = new Date('2026-10-15T21:00:00Z');

const listings = async (endpoint, params) => {
  assert.equal(endpoint, 'get_event_listings');
  assert.equal(params.event_id, 'chosen');

  return {
    event_id: 'chosen',
    listing_status: 'AVAILABLE',
    page_info: { has_next_page: false },
    listings: [{
      id: 'listing',
      event: { id: 'chosen' },
      number_of_available_tickets: 2,
      price: {
        total_price: { currency: 'EUR', amount: 2500 }
      }
    }]
  };
};

test('numbered event titles work for arbitrary artists', () => {
  for (const artist of ['Example Band', 'Another Artist']) {
    for (const suffix of ['30', '25', '2027', '30th']) {
      assert.equal(resolveTicketSwap({ ...c, artist }, [{
        __typename: 'EventResult',
        id: 'chosen',
        name: artist + ' ' + suffix,
        startDate: c.date,
        locationName: c.venue,
        cityName: c.city,
        country: { code: 'NL' },
        uri: { url: candidate.url }
      }]).status, 'matched');
    }
  }
});

test('confirmed event fetches tickets and is remembered', async () => {
  const first = await checkConcert(c, old(), listings, now, 'chosen');
  assert.equal(first.status, 'ok');
  assert.equal(first.availableTickets, 2);
  assert.equal(first.lowestPriceCents, 2500);
  assert.equal(first.event.confirmedByUser, true);

  const next = await checkConcert(c, first, listings, now);
  assert.equal(next.status, 'ok');
  assert.equal(next.event.id, 'chosen');
});

test('unoffered event IDs never call the provider', async () => {
  let calls = 0;
  const result = await checkConcert(
    c, old(), async () => { calls++; }, now, 'unknown'
  );
  assert.equal(result.status, 'error');
  assert.equal(calls, 0);
});

test('invalid selections are rejected before API calls', async () => {
  const cases = [
    { ...old(), identity: 'changed' },
    ...[
      { date: '2027-02-21' },
      { country: 'BE' },
      { url: 'https://ticketswap.com.evil.test' }
    ].map(change => ({
      ...old(),
      matchCandidates: [{ ...candidate, ...change }]
    }))
  ];

  for (const entry of cases) {
    let calls = 0;
    const result = await checkConcert(
      c, entry, async () => { calls++; }, now, 'chosen'
    );
    assert.equal(result.status, 'error');
    assert.equal(calls, 0);
  }
});

test('failed checks preserve the confirmed event for retry', async () => {
  const failed = await checkConcert(
    c, old(), async () => { throw Error('offline'); }, now, 'chosen'
  );
  assert.equal(failed.status, 'error');
  assert.equal(failed.event.id, 'chosen');

  const retried = await checkConcert(c, failed, listings, now);
  assert.equal(retried.status, 'ok');
});
