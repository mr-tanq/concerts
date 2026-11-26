import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetedRequest, emptyLedger } from './lib/ticketswap-budget.mjs';
import { createSnapshotCache } from '../js/ticketswap-snapshot.js';
import { summarizeListings } from './lib/ticketswap-summary.mjs';
import { canConfirmTicketSwap } from '../js/ticketswap-matching.js';

const date = Date.parse('2026-11-26T00:00:00Z');
const policy = { initial: 4, daily: 2, monthly: 3, reserve: 1 };

test('identical requests share a durable debit and different requests honor the caps', async () => {
  const ledger = emptyLedger();
  let time = date;
  const saved = [];
  let calls = 0;
  const request = createBudgetedRequest({
    ledger, policy, now: () => time,
    persist: async value => saved.push(structuredClone(value)),
    transport: async () => {
      calls++;
      assert.equal(saved.at(-1).days[new Date(time).toISOString().slice(0, 10)], calls === 2 ? 2 : 1);
      return calls;
    }
  });
  const run = query => request('search_events', { query });
  assert.deepEqual(await Promise.all([run('a'), run('a'), run('b')]), [1, 1, 2]);
  assert.equal(await run('a'), 1);
  await assert.rejects(run('c'), /budget exhausted/);
  time += 86400000;
  assert.equal(await run('c'), 3);
  await assert.rejects(run('d'), /budget exhausted/);
  assert.equal(ledger.remaining, 1);
  assert.deepEqual(ledger.endpoints.search_events, {
    estimated: 3, actual: 0, accounted: 3, unverified: 3
  });
  await assert.rejects(request('get_market_batch', {}), /Unsupported/);
});

test('trusted headers reconcile known charges and failures back off without automatic retries', async () => {
  const ledger = emptyLedger();
  let time = date;
  let calls = 0;
  const request = createBudgetedRequest({
    ledger, policy, now: () => time, trustHeaders: true,
    persist: async () => {},
    transport: async (_endpoint, _params, feedback) => {
      calls++;
      feedback({ status: 429, charged: 0, remaining: 2, retryAfterMs: 120000 });
      throw new Error('rate limited');
    }
  });
  await assert.rejects(request('search_events', {}), /rate limited/);
  assert.equal(ledger.remaining, 2);
  assert.equal(ledger.days['2026-11-26'], 0);
  assert.equal(ledger.endpoints.search_events.unverified, 0);
  await assert.rejects(request('search_events', {}), /temporarily paused/);
  assert.equal(calls, 1);
  time += 120000;
  await assert.rejects(request('search_events', {}), /rate limited/);
  assert.equal(calls, 2);
});

test('failed budget persistence prevents the network call', async () => {
  let calls = 0;
  const request = createBudgetedRequest({
    ledger: emptyLedger(), policy, now: () => date,
    persist: async () => { throw new Error('write failed'); },
    transport: async () => { calls++; }
  });
  await assert.rejects(request('search_events', {}), /Could not save/);
  await assert.rejects(request('search_events', {}), /storage unavailable/);
  assert.equal(calls, 0);
});

test('reopening revalidates a cached snapshot and preserves newer or stale data', async () => {
  let time = date;
  let reads = 0;
  const first = { version: 1, updatedAt: new Date(date).toISOString(), entries: {} };
  const second = { ...first, updatedAt: new Date(date + 100).toISOString() };
  let read = async () => first;
  const cache = createSnapshotCache(() => { reads++; return read(); }, { now: () => time, ttl: 50 });
  await Promise.all([cache.load(), cache.load()]);
  assert.equal(reads, 1);
  time += 50;
  const older = cache.load();
  cache.publish(second);
  assert.deepEqual(await older, { data: second, stale: false });
  time += 50;
  read = async () => { throw new Error('offline'); };
  assert.deepEqual(await cache.load(), { data: second, stale: true });
  assert.deepEqual(await cache.load(), { data: second, stale: true });
  assert.equal(reads, 3);
});

test('listing summaries preserve sampled coverage and invalid prices never become zero', () => {
  const row = (id, currency, amount) => ({
    id, event: { id: 'event' }, number_of_available_tickets: 2,
    price: { total_price: { currency, amount } }
  });
  const body = {
    event_id: 'event', listing_status: 'AVAILABLE',
    page_info: { has_next_page: true },
    listings: [row('a', 'EUR', 2350), row('a', 'EUR', 2350),
      row('b', 'USD', 10), row('c', 'EUR', -1), row('d', 'EUR', null)]
  };
  const { market, ...summary } = summarizeListings(body);
  assert.equal(market.activeListings, 4);
  assert.deepEqual(summary, {
    availableTickets: 8, lowestPriceCents: 2350, currency: 'EUR',
    complete: false, missingPrices: true
  });
  assert.equal(summarizeListings({ ...body, listings: [] }).complete, false);
  assert.throws(() => summarizeListings({ ...body, page_info: {} }), /Unexpected/);
  assert.throws(() => summarizeListings({
    ...body, listings: [row('a', 'EUR', 2350), { ...row('a', 'EUR', 2350), event: { id: 'wrong' } }]
  }), /different event/);
});

test('shared confirmation requires compatible city, room, title and safe URL', () => {
  const concert = {
    artist: 'Example Band', date: '2027-02-20',
    venue: 'Examplehouse', city: 'Utrecht', country: 'NL'
  };
  const candidate = {
    ...concert, name: 'Other Act presents Example Band',
    id: 'chosen', url: 'https://ticketswap.com/event/example'
  };
  assert.equal(canConfirmTicketSwap(concert, candidate), true);
  for (const change of [
    { city: 'Amsterdam' }, { venue: 'Examplehouse Room 2' },
    { name: 'Example Band Parking' }, { name: 'Example Bandits' },
    { url: 'https://ticketswap.com:8080/event/example' }
  ]) assert.equal(canConfirmTicketSwap(concert, { ...candidate, ...change }), false);
});
