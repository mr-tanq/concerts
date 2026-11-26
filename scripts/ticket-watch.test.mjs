import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicketWatchAdapters } from './lib/ticketswap-watch-api.mjs';
import { runTicketWatches } from './lib/ticket-watch-runner.mjs';
import { summarizeListings } from './lib/ticketswap-summary.mjs';
import { emptyLedger, spendableCredits } from './lib/ticketswap-budget.mjs';
import { watchPreferences, watchStopReason, evaluateTicketWatch } from '../js/ticket-watch.js';
import { identity } from '../js/ticketswap-matching.js';

const now = Date.parse('2026-11-26T18:00:00Z');
const date = '2026-11-28';
const concert = { id: 'example', artist: 'Example', date, city: 'Utrecht', venue: 'Examplehouse', country: 'NL' };
const event = { id: 'event-a', url: 'https://ticketswap.com/event/example', date, name: 'Example' };
const watch = { watchId: 'watch-1', revision: 'rev-1', identity: identity(concert), quantity: 1, categoryId: 'ga',
  maxCents: 2600, paused: false, alerts: ['available', 'threshold', 'drop', 'lastMinute'] };
const row = (amount, quantity = 1) => ({
  id: 'listing-1', event: { id: event.id }, ticket_type: { id: 'ga', title: 'GA' },
  number_of_available_tickets: quantity, number_of_tickets_in_listing: quantity,
  price: { total_price: { currency: 'EUR', amount } }
});
const market = (listings, partial = false) => summarizeListings({
  listing_status: 'AVAILABLE', event_id: event.id, listings,
  page_info: { has_next_page: partial }
});
const observation = (time, listings, partial = false) => ({
  identity: watch.identity, event, status: 'ok', checkedAt: new Date(time).toISOString(),
  ...market(listings, partial)
});
const mockStore = (entries = {}) => ({ version: 1, entries });

test('watch preferences parse integer cents and enforce quantity and local stop rules', () => {
  assert.equal(watchPreferences({ maxPrice: '29,95', quantity: '2', categoryId: 'ga', alerts: ['drop'] }).maxCents, 2995);
  assert.throws(() => watchPreferences({ maxPrice: '1.111', quantity: '1', alerts: [] }));
  assert.throws(() => watchPreferences({ quantity: 11, alerts: [] }));
  assert.equal(watchStopReason({ ...concert, practical: { ticketBought: true } }, now), 'Tickets already owned');
  assert.equal(watchStopReason({ ...concert, date: '2026-11-25' }, now), 'Concert has passed');
});

test('watch alerts deduplicate unchanged checks and never treat partial or mismatched lots as absence', () => {
  const initial = evaluateTicketWatch(watch, concert, observation(now, [row(2500)]), now);
  assert.deepEqual(initial.notifications.map(item => item.kind), ['available', 'threshold', 'lastMinute']);
  assert.equal(evaluateTicketWatch(initial, concert, observation(now, [row(2500)]), now), initial);
  const partial = evaluateTicketWatch(initial, concert, observation(now + 1000, [], true), now + 1000);
  assert.equal(partial.signals.available, true);
  const priceDrop = evaluateTicketWatch(initial, concert, observation(now + 1000, [row(2000)]), now + 1000);
  assert.equal(priceDrop.notifications.at(-1).kind, 'drop');
  const next = evaluateTicketWatch(priceDrop, concert, observation(now + 2000, [row(2000)]), now + 2000);
  assert.equal(next.notifications.length, priceDrop.notifications.length);
  const wrongLot = evaluateTicketWatch({ ...watch, quantity: 2 }, concert, observation(now, [row(2500)]), now);
  assert.equal(wrongLot.notifications.length, 0);
  assert.equal(evaluateTicketWatch({ ...watch, paused: true }, concert, observation(now, [row(2500)]), now).notifications, undefined);
});

test('batch adapters enforce mode limits and preserve independent coverage and per-item failure', async () => {
  const calls = [];
  const adapters = createTicketWatchAdapters(async (endpoint, params) => {
    calls.push([endpoint, params]);
    return { results: [
      { event_type_id: 'ga', found: true, event_type: { id: 'ga', event: { id: event.id } },
        available: { listings: [row(100)], page_info: { has_next_page: true, end_cursor: 'av-next' } },
        sold: { listings: [], page_info: { has_next_page: false } } },
      { event_type_id: 'bad', found: false, error: 'Unsupported' }
    ], event_types_requested: 2, event_types_found: 1, operations_sent: 1 };
  });
  await assert.rejects(adapters.marketBatch(Array.from({ length: 11 }, (_, i) => String(i))), /batch size/);
  await assert.rejects(adapters.marketBatch(['a', 'b', 'c', 'd', 'e', 'f'], { mode: 'FULL_MARKET' }), /batch size/);
  await assert.rejects(adapters.marketBatch(['https://ticketswap.com.evil.invalid/x']), /type URL/);
  const available = await adapters.marketBatch(['ga', 'bad']);
  assert.equal(available.results[0].sold, null);
  assert.equal(available.results[0].available.complete, false);
  assert.equal(available.results[0].available.cursor, 'av-next');
  assert.equal(available.results[1].found, false);
  const full = await adapters.marketBatch(['ga', 'bad'], { mode: 'FULL_MARKET', soldFirst: 25 });
  assert.equal(full.results[0].sold.complete, true);
  assert.deepEqual(calls[1], ['get_market_batch', {
    mode: 'FULL_MARKET', event_types: ['ga', 'bad'], currency: 'EUR', available_first: 30, sold_first: 25
  }]);
});

test('demand preserves text and sold sampling supports per-event cursors without inventing sales', async () => {
  const adapters = createTicketWatchAdapters(async (endpoint, params) => {
    if (endpoint === 'get_event_demand') return {
      demand: { has_demand: true, recently_sold: 'Several went recently' },
      event_types: [{ id: 'ga', demand: { price_levels: [{ text: 'More than 5 waiting' }] } }]
    };
    assert.deepEqual(params.event_ids, [{ id: event.id, after: 'cursor' }, 'missing']);
    return { results: [{ event_id: event.id, found: true, coverage: 'sample',
      listings: [row(2500)], page_info: { has_next_page: true, end_cursor: 'next' } }] };
  });
  const demand = await adapters.eventDemand(event.id);
  assert.equal(demand.types[0].priceLevels[0].text, 'More than 5 waiting');
  assert.equal(demand.types[0].instantSellable, null);
  const sold = await adapters.soldSample([{ id: event.id, after: 'cursor' }, 'missing']);
  assert.equal(sold[0].group.complete, false);
  assert.equal(sold[0].group.cursor, 'next');
  assert.equal(sold[1].found, false);
});

test('scheduler batches remembered categories, protects manual observations and skips stopped watches', async () => {
  const prior = observation(now - 24 * 3600000, [row(3000)]);
  const second = { ...concert, id: 'other', artist: 'Other' };
  const owned = { ...concert, id: 'owned', practical: { ticketBought: true } };
  const otherObservation = {
    ...prior, identity: identity(second), event: { ...event, id: 'event-b' },
    market: { ...prior.market, categories: [{ ...prior.market.categories[0], id: 'other-type' }] }
  };
  const options = {
    concerts: [concert, second, owned], now, spendableCredits: 1, state: mockStore(),
    watches: mockStore({
      example: watch,
      other: { ...watch, identity: identity(second), watchId: 'watch-2', categoryId: 'other-type' },
      owned: { ...watch, identity: identity(owned), watchId: 'watch-3' }
    }),
    snapshot: mockStore({ example: prior, other: otherObservation }), official: mockStore()
  };
  const preview = await runTicketWatches(options);
  assert.equal(preview.estimate.credits, 1);
  assert.equal(preview.estimate.due, 2);
  assert.equal(preview.entries.owned.stop, 'Tickets already owned');
  const monitored = await runTicketWatches({ ...options, request: async (endpoint, params) => {
    assert.equal(endpoint, 'get_market_batch');
    assert.deepEqual(new Set(params.event_types), new Set(['ga', 'other-type']));
    return { results: [
      { event_type_id: 'ga', found: true, event_type: { id: 'ga', event: { id: event.id } },
        available: { listings: [row(2400)], page_info: { has_next_page: false } } },
      { event_type_id: 'other-type', found: false }
    ] };
  } });
  assert.equal(monitored.entries.example.observation.lowestPriceCents, 2400);
  assert.equal(monitored.entries.example.monitor.notifications.length, 3);
  assert.equal(monitored.entries.other.availabilityState, 'unavailable');
  assert.equal(monitored.entries.other.observation.checkedAt, prior.checkedAt);
  const noBudget = await runTicketWatches({ ...options, spendableCredits: 0,
    request: async () => assert.fail('Unexpected paid call') });
  assert.equal(noBudget.estimate.credits, 0);
  const policy = { initial: 194, daily: 8, monthly: 40, reserve: 20 };
  assert.equal(spendableCredits({ ...emptyLedger(), remaining: 21 }, policy, now), 1);
  assert.equal(spendableCredits({ ...emptyLedger(), remaining: 20 }, policy, now), 0);
});

test('a cached run integrates a fresh official comparison for the same one-ticket category', async () => {
  const entry = observation(now, [row(2500)]);
  const result = await runTicketWatches({ concerts: [concert], watches: mockStore({ example: watch }),
    state: mockStore(), snapshot: mockStore({ example: entry }), now, spendableCredits: 0,
    official: mockStore({ example: { identity: watch.identity, offers: [{ seller: 'Venue', category: 'GA',
      verifiedAt: entry.checkedAt, quantity: 1, feeInclusive: true, currency: 'EUR', finalCents: 3000,
      availability: 'available', resaleTypeId: 'ga', resaleEventId: event.id }] } })
  });
  assert.equal(result.entries.example.officialComparison.savingsCents, 500);
});

test('new provider transport remains gated and encodes the proposed GET contract without a body', async t => {
  const { ticketSwapRequest } = await import('./lib/ticketswap-api.mjs');
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.PARSE_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PARSE_API_KEY;
    else process.env.PARSE_API_KEY = originalKey;
  });
  process.env.PARSE_API_KEY = 'offline-fixture';
  globalThis.fetch = async (href, options) => {
    const url = new URL(href);
    assert.equal(url.pathname.split('/').at(-1), 'get_market_batch');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.deepEqual(JSON.parse(url.searchParams.get('event_types')), ['type-a']);
    return Response.json({ status: 'success', data: { results: [] } }, {
      headers: { 'X-Credits-Charged': '1', 'X-Credits-Remaining': 'unknown', 'Retry-After': '7' }
    });
  };
  await assert.rejects(ticketSwapRequest('get_market_batch', {}), /disabled/);
  let headers;
  const result = await ticketSwapRequest('get_market_batch', { event_types: ['type-a'] },
    value => { headers = value; }, { watch: true });
  assert.deepEqual(headers, { status: 200, charged: 1, remaining: null, retryAfterMs: 7000 });
  assert.deepEqual(result, { results: [] });
});

test('paused or stale observations produce no alerts and raising the cap only unlocks the new threshold', async () => {
  const { updateWatch } = await import('../js/ticket-watch.js');
  const recent = observation(now, [row(2700)]);
  const first = evaluateTicketWatch(watch, concert, recent, now);
  assert.deepEqual(first.notifications.map(item => item.kind), ['available']);
  const changed = updateWatch(first, concert, { ...watch, maxCents: 2800 });
  const result = evaluateTicketWatch(changed, concert, recent, now);
  assert.deepEqual(result.notifications.map(item => item.kind), ['available', 'threshold', 'lastMinute']);
  const unchanged = updateWatch(result, concert, { ...watch, maxCents: 3000 });
  assert.equal(evaluateTicketWatch(unchanged, concert, recent, now).notifications.length, 3);
  const paused = { ...changed, paused: true };
  assert.equal(evaluateTicketWatch(paused, concert, recent, now), paused);
  assert.equal(evaluateTicketWatch(changed, concert, recent, now + 7 * 3600000), changed);
});

test('preference changes between planning and execution prevent paid calls', async () => {
  const prior = observation(now - 24 * 3600000, [row(3000)]);
  const options = { concerts: [concert], watches: mockStore({ example: watch }), state: mockStore(),
    snapshot: mockStore({ example: prior }), official: mockStore(), now, spendableCredits: 4,
    request: async () => assert.fail('Paid call for changed or paused watch') };
  for (const changed of [{ ...watch, paused: true }, { ...watch, revision: 'new-revision', quantity: 2 }]) {
    const result = await runTicketWatches({ ...options, refreshWatches: async () => mockStore({ example: changed }) });
    assert.equal(result.entries.example.observation.checkedAt, prior.checkedAt);
    assert.equal(result.entries.example.lastAttemptAt, undefined);
  }
});

test('provider failures preserve the observation, retry after backoff, and never flag a budget deferral as a failure', async () => {
  const prior = observation(now - 24 * 3600000, [row(3000)]);
  const options = { concerts: [concert], watches: mockStore({ example: watch }), state: mockStore(),
    snapshot: mockStore({ example: prior }), official: mockStore(), now, spendableCredits: 4 };
  const failed = await runTicketWatches({ ...options, request: async () => { throw new Error('Upstream failure'); } });
  assert.equal(failed.entries.example.observation.checkedAt, prior.checkedAt);
  assert.equal(failed.entries.example.retryAt, new Date(now + 15 * 60000).toISOString());
  const early = await runTicketWatches({ ...options, state: failed, now: now + 1000,
    request: async () => assert.fail('Backoff did not hold') });
  assert.equal(early.estimate.due, 0);
  const deferred = await runTicketWatches({ ...options, state: failed, now: now + 15 * 60000,
    request: async () => { throw new Error('TicketSwap credit budget exhausted'); } });
  assert.equal(deferred.estimate.due, 1);
  assert.equal(deferred.entries.example.failureCount, 1);
  assert.equal(deferred.entries.example.lastAttemptAt, failed.entries.example.lastAttemptAt);
});

test('newly discovered categories combine only for the latest event identity', async () => {
  const { watchCategoryOptions } = await import('../js/ticket-watch-panel.js');
  const manual = observation(now, [row(2400)]);
  const cached = { observation: observation(now + 10, [row(2300)]),
    knownTypes: [{ eventId: event.id, id: 'balcony', title: 'Balcony' },
      { eventId: 'another-event', id: 'wrong', title: 'Wrong' }] };
  assert.deepEqual(watchCategoryOptions(concert, manual, cached), [['balcony', 'Balcony'], ['ga', 'GA']]);
  const newEvent = { ...manual, checkedAt: new Date(now + 20).toISOString(), event: { id: 'new-event' } };
  assert.deepEqual(watchCategoryOptions(concert, newEvent, cached), [['ga', 'GA']]);
  assert.deepEqual(watchCategoryOptions({ ...concert, date: '2027-05-01' }, manual, cached), []);
});

test('validation plan is offline and has a deterministic five-credit ceiling without retries', async () => {
  const { ticketWatchValidationPlan } = await import('./plan-ticket-watch-validation.mjs');
  const plan = ticketWatchValidationPlan();
  assert.equal(plan.maximumDocumentedCredits, 5);
  assert.equal(plan.maximumCalls, 5);
  assert.equal(plan.retries, 0);
  assert.equal(plan.requiresSeparateOwnerApproval, true);
  assert.equal(plan.steps.at(-1).onlyWithReturnedCursor, true);
});
