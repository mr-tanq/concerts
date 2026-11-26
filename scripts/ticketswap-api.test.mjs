import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketSwapRequest } from './lib/ticketswap-api.mjs';
import { checkConcert } from './lib/ticketswap-going.mjs';

const concert = {
  artist: 'Example Band', date: '2027-02-20',
  venue: 'Examplehouse', city: 'Utrecht', country: 'NL'
};
const event = {
  __typename: 'EventResult', id: 'chosen', name: concert.artist,
  startDate: concert.date, locationName: concert.venue, cityName: concert.city,
  country: { code: concert.country },
  uri: { url: 'https://www.ticketswap.com/event/example' }
};
const search = { results: [event], page_info: { hasNextPage: false } };
const listings = {
  event_id: event.id, listing_status: 'AVAILABLE',
  page_info: { has_next_page: false }, listings: []
};

test('direct and wrapped successful responses complete a check', async t => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.PARSE_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PARSE_API_KEY;
    else process.env.PARSE_API_KEY = originalKey;
  });
  process.env.PARSE_API_KEY = 'test-key';

  for (const wrapped of [false, true]) {
    globalThis.fetch = async url => {
      const data = url.endsWith('/search_events') ? search : listings;
      return Response.json(wrapped ? { status: 'success', data } : data);
    };
    const result = await checkConcert(concert, null, ticketSwapRequest);
    assert.equal(result.status, 'ok');
    assert.equal(result.availableTickets, 0);
    assert.equal(result.lastError, null);
  }
});

test('source errors retain safe diagnostics and do not prevent subsequent checks', async t => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.PARSE_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PARSE_API_KEY;
    else process.env.PARSE_API_KEY = originalKey;
  });
  process.env.PARSE_API_KEY = 'test-key';
  let failing = true;
  globalThis.fetch = async url => failing
    ? Response.json({ error: {
      kind: 'antibot_solvable', upstream_status_code: 503,
      message: 'private upstream response'
    } }, { status: 503 })
    : Response.json(url.endsWith('/search_events') ? search : listings);

  const failed = await checkConcert(concert, null, ticketSwapRequest);
  assert.equal(failed.status, 'error');
  assert.equal(failed.lastError, 'TicketSwap search_events: HTTP 503, antibot_solvable, upstream HTTP 503');
  failing = false;
  const next = await checkConcert(concert, failed, ticketSwapRequest);
  assert.equal(next.status, 'ok');
  assert.equal(next.lastError, null);
});

test('invalid and unsuccessful responses are reported as errors', async t => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.PARSE_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PARSE_API_KEY;
    else process.env.PARSE_API_KEY = originalKey;
  });
  process.env.PARSE_API_KEY = 'test-key';
  for (const body of [
    { status: 'error', data: search }, { status: 'success', data: null },
    { error: 'failed' }, null
  ]) {
    globalThis.fetch = async () => Response.json(body);
    assert.equal((await checkConcert(concert, null, ticketSwapRequest)).status, 'error');
  }
  globalThis.fetch = async () => new Response('not json');
  assert.equal((await checkConcert(concert, null, ticketSwapRequest)).lastError,
    'TicketSwap search_events: invalid JSON response');
});
