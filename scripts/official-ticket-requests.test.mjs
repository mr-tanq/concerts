import test from 'node:test';
import assert from 'node:assert/strict';
import { processOfficialTicketRequests } from './lib/official-ticket-requests.mjs';
import { identity } from '../js/ticketswap-matching.js';
import { readFile } from 'node:fs/promises';

const now = Date.parse('2026-11-26T18:00:00Z');
const concert = { id: 'example', artist: 'Example Band', date: '2027-02-20',
  venue: 'TivoliVredenburg', city: 'Utrecht', country: 'NL',
  officialUrl: 'https://www.tivolivredenburg.nl/agenda/example/' };
const request = (item, n, age = 1000) => ({
  identity: identity(item), requestId: '00000000-0000-4000-a000-' + String(n).padStart(12, '0'),
  requestedAt: new Date(now - age).toISOString()
});
const args = { clock: () => now, mappings: [], resale: {}, concerts: [concert],
  store: { version: 1, entries: {} } };
const html = await readFile(new URL('./fixtures/official-ticket-venue.html', import.meta.url), 'utf8');

test('an authenticated queue item gets a single acknowledged result, preserving manual evidence', async () => {
  let reads = 0;
  const manual = { seller: 'Manual checkout' };
  const store = { version: 1, entries: { example: { identity: identity(concert), offers: [manual] } } };
  const item = request(concert, 1);
  const options = { ...args, store, queue: { version: 1, requests: { example: item } },
    readPage: async source => { reads++; return { html, url: source.url, observedAt: now }; } };
  const refreshed = await processOfficialTicketRequests(options);
  const entry = refreshed.entries.example;
  assert.equal(entry.lastCheck.requestId, item.requestId);
  assert.equal(entry.lastCheck.status, 'verified');
  assert.equal(entry.lastCheck.identity, identity(concert));
  assert.deepEqual(entry.offers, [manual]);
  assert.equal(await processOfficialTicketRequests({ ...options, store: refreshed }), refreshed);
  assert.equal(reads, 1);
});

test('unsupported, outdated identity, and expired requests never contact a publisher', async () => {
  const unsupported = { ...concert, id: 'unsupported', officialUrl: null };
  const a = request(unsupported, 1);
  const b = request({ ...concert, venue: 'Wrong room' }, 2);
  const result = await processOfficialTicketRequests({ ...args, concerts: [concert, unsupported],
    queue: { version: 1, requests: {
      unsupported: a, example: b, expired: request(concert, 3, 11 * 60000), malformed: { requestId: 'bad' }
    } },
    readPage: async () => assert.fail('Unexpected publisher access')
  });
  assert.deepEqual(Object.keys(result.entries).sort(), ['example', 'unsupported']);
  assert.equal(result.entries.unsupported.lastCheck.status, 'unsupported');
  assert.equal(result.entries.example.lastCheck.status, 'invalid');
});

test('publishing a new request during the cache interval reuses existing evidence', async () => {
  let reads = 0;
  const options = { ...args, readPage: async source => { reads++; return { html, url: source.url, observedAt: now }; } };
  const queue = n => ({ version: 1, requests: { example: request(concert, n) } });
  const first = await processOfficialTicketRequests({ ...options, queue: queue(1) });
  const second = await processOfficialTicketRequests({ ...options, store: first, queue: queue(2) });
  assert.equal(second.entries.example.lastCheck.status, 'cached');
  assert.equal(second.entries.example.lastCheck.requestId, queue(2).requests.example.requestId);
  assert.equal(reads, 1);
});

test('publisher failures return an acknowledgement and keep the prior snapshot and manual evidence', async () => {
  const item = request(concert, 1);
  const options = { ...args, queue: { version: 1, requests: { example: item } },
    readPage: async () => { throw new Error('403 upstream'); } };
  const result = await processOfficialTicketRequests(options);
  assert.equal(result.entries.example.lastCheck.status, 'unavailable');
  assert.equal(Object.values(result.entries.example.providerChecks)[0].status, 'failed');
});
