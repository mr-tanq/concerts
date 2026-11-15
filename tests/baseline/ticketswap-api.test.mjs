// Deterministic baseline for TicketSwap API; no network access or real keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketSwapRequest } from '../../scripts/lib/ticketswap-api.mjs';

const originalFetch = globalThis.fetch;
const originalKey = process.env.PARSE_API_KEY;
function restore() {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.PARSE_API_KEY;
  else process.env.PARSE_API_KEY = originalKey;
}
test.after(restore);

test('blocks unsupported TicketSwap operations before calling any network client', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw Error('unexpected network'); };
  process.env.PARSE_API_KEY = 'fake-test-key';
  await assert.rejects(ticketSwapRequest('delete_all_events', {}), /Unsupported TicketSwap endpoint/);
  await assert.rejects(ticketSwapRequest('../search_events', {}), /Unsupported TicketSwap endpoint/);
  assert.equal(called, false);
});

test('requires an explicitly configured Parse.bot key', async () => {
  delete process.env.PARSE_API_KEY;
  let called = false;
  globalThis.fetch = async () => { called = true; throw Error('unexpected network'); };
  await assert.rejects(ticketSwapRequest('search_events', { query: 'MONO' }), /Missing PARSE_API_KEY/);
  assert.equal(called, false);
});

test('uses POST with correct JSON body and time bound for approved endpoints', async () => {
  process.env.PARSE_API_KEY = 'fake-test-key';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: 'success', data: { events: [] } }) };
  };
  for (const endpoint of ['search_events', 'get_event_listings']) {
    const params = { sample: 'test-only' };
    const result = await ticketSwapRequest(endpoint, params);
    assert.deepEqual(result, { events: [] });
  }
  assert.equal(calls.length, 2);
  for (let i = 0; i < calls.length; i++) {
    const { url, options } = calls[i];
    assert.equal(new URL(url).host, 'api.parse.bot');
    assert.equal(new URL(url).pathname.endsWith('/' + ['search_events', 'get_event_listings'][i]), true);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-API-Key'], 'fake-test-key');
    assert.deepEqual(JSON.parse(options.body), { sample: 'test-only' });
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('rejects HTTP errors, unsuccessful payloads and missing data', async () => {
  process.env.PARSE_API_KEY = 'fake-test-key';
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(ticketSwapRequest('search_events', {}), /HTTP 503/);
  for (const response of [
    { status: 'error', data: {} },
    { status: 'success', data: null },
    { status: 'success' }
  ]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => response });
    await assert.rejects(ticketSwapRequest('search_events', {}), /unsuccessful response/);
  }
});
