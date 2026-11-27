import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { officialTicketSources, parseOfficialTicketPage } from './sources/official-ticket-providers.mjs';
import { createOfficialPageReader } from './sources/official-ticket-http.mjs';
import { refreshOfficialTickets } from './lib/official-ticket-refresh.mjs';
import { recordOfficialOffer } from './record-official-offer.mjs';
import { identity } from '../js/ticketswap-matching.js';

const html = await readFile(new URL('./fixtures/official-ticket-venue.html', import.meta.url), 'utf8');
const now = Date.parse('2026-11-26T17:00:00Z');
const concert = {
  id: 'planned-example', artist: 'Example Band', date: '2027-02-20', venue: 'TivoliVredenburg',
  city: 'Utrecht', country: 'NL', sourceUrl: 'https://www.podiuminfo.nl/concert/example',
  schedule: { sources: [
    { kind: 'official', url: 'https://www.tivolivredenburg.nl/agenda/example/?utm_campaign=fixture' },
    { kind: 'secondary', url: 'https://www.podiuminfo.nl/concert/example' }
  ] }
};
const [source] = officialTicketSources(concert);
const empty = { version: 1, entries: {} };

test('approved candidates reuse Dutch schedule sources and direct Ticketmaster event URLs', () => {
  assert.equal(source.url, 'https://www.tivolivredenburg.nl/agenda/example/');
  assert.equal(officialTicketSources({ ...concert, schedule: null, officialUrl: 'https://www.tivolivredenburg.nl/' }).length, 0);
  assert.equal(officialTicketSources({ ...concert, officialUrl: 'https://tivolivredenburg.nl.evil.invalid/agenda/x' }).length, 1);
  // A stored direct seller link takes the first slot; the venue page follows.
  const withTicketmaster = officialTicketSources({ ...concert, ticketUrl: 'https://www.ticketmaster.nl/event/123' });
  assert.deepEqual(withTicketmaster.map(item => item.provider), ['ticketmaster-jsonld', 'venue-jsonld']);
});

test('structured event offers retain EUR components, stock, timestamp and checkout provenance', () => {
  const [standing, balcony] = parseOfficialTicketPage(html, concert, source, now);
  assert.deepEqual([standing.listedCents, standing.baseCents, standing.feesCents, standing.finalCents], [2450, 2450, 225, 2675]);
  assert.equal(standing.availability, 'available');
  assert.equal(standing.feeInclusive, true);
  assert.equal(standing.verifiedAt, new Date(now).toISOString());
  assert.equal(standing.offerKey, 'standing-1');
  assert.equal(balcony.purchaseUrl, source.url);
  assert.equal(balcony.availability, 'sold-out');
  assert.equal(balcony.baseCents, null);
  assert.equal(balcony.finalCents, null);
  assert.equal(balcony.listedCents, 3450);
});

test('price alone does not establish availability, item quantity, or fees', () => {
  const sourceHTML = html
    .replace('"availability": "https://schema.org/InStock"', '"availability": "https://schema.org/PreOrder"')
    .replace('"value": 1', '"value": 2');
  const [standing] = parseOfficialTicketPage(sourceHTML, concert, source, now);
  assert.equal(standing.availability, 'unknown');
  assert.equal(standing.finalCents, null);
  const [inconsistent] = parseOfficialTicketPage(html.replace('"26.75"', '"25.00"'), concert, source, now);
  assert.equal(inconsistent.finalCents, null);
  const [mixed] = parseOfficialTicketPage(html.replace('"26.75", "priceCurrency": "EUR"', '"26.75", "priceCurrency": "USD"'), concert, source, now);
  assert.equal(mixed.finalCents, null);
  const [stockOnly] = parseOfficialTicketPage(
    html.replaceAll('"priceCurrency": "EUR"', '"priceCurrency": "INVALID"'), concert, source, now);
  assert.equal(stockOnly.currency, null);
  assert.equal(stockOnly.availability, 'available');
});

test('wrong date, room, country, ambiguity and non-official listing types do not verify', () => {
  for (const change of [{ venue: 'Other room' }, { date: '2027-02-21' }, { country: 'BE' }, { artist: 'Other Band' }]) {
    assert.deepEqual(parseOfficialTicketPage(html, { ...concert, ...change }, source, now), []);
  }
  assert.deepEqual(parseOfficialTicketPage(html + html, concert, source, now), []);
  const expires = html.replace('"sku": "standing-1"', '"sku": "standing-1", "priceValidUntil": "2026-11-25"');
  assert.equal(parseOfficialTicketPage(expires, concert, source, now)[0].finalCents, null);
  const tm = { url: 'https://www.ticketmaster.nl/event/123', domain: 'ticketmaster.nl', provider: 'ticketmaster-jsonld', label: 'Ticketmaster' };
  assert.deepEqual(parseOfficialTicketPage(html, concert, tm, now), []);
  const standard = html.replace('"Staanplaats"', '"Standard Ticket"');
  assert.equal(parseOfficialTicketPage(standard, concert, tm, now)[0].finalCents, 2675);
});

test('public transport obeys robots, coalesces reads and rejects cross-host redirects', async () => {
  const calls = [];
  const reader = createOfficialPageReader({ now: () => now, fetcher: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.match(options.headers['User-Agent'], /^ListeningMirrorTickets/);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /private', { headers: { 'content-type': 'text/plain' } });
    if (url.endsWith('/redirect')) return new Response(null, { status: 302, headers: { location: 'https://example.net/' } });
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  } });
  const [first, second] = await Promise.all([reader(source), reader(source)]);
  assert.equal(first, second);
  assert.equal(calls.length, 2);
  await assert.rejects(reader({ ...source, url: 'https://www.tivolivredenburg.nl/private' }), /robots/);
  await assert.rejects(reader({ ...source, url: 'https://www.tivolivredenburg.nl/redirect' }), /access unavailable/);
  assert.equal(calls.length, 3);
});

test('a publisher block stops subsequent requests without retrying or following an alternate host', async () => {
  const calls = [];
  const reader = createOfficialPageReader({ fetcher: async url => {
    calls.push(url);
    if (url.endsWith('/robots.txt')) return new Response(null, { status: 404 });
    return new Response('rate limited', { status: 429 });
  } });
  await assert.rejects(reader(source), /unavailable/);
  await assert.rejects(reader({ ...source, url: 'https://tivolivredenburg.nl/agenda/other' }), /access unavailable/);
  assert.equal(calls.length, 2);
});

test('persistent cache retains evidence on failure and only maps exact verified categories', async () => {
  const eventIdentity = identity(concert);
  const resale = { identity: eventIdentity, event: { id: 'ts-event' }, market: { categories: [{ id: 'ts-ga' }] } };
  const mappings = [{
    concertId: concert.id, identity: eventIdentity, sourceUrl: source.url, offerKey: 'standing-1',
    category: 'Staanplaats', resaleEventId: 'ts-event', resaleTypeId: 'ts-ga',
    equivalenceEvidence: 'Same standing area and access terms'
  }];
  let reads = 0;
  const readPage = async () => { reads++; return { html, url: source.url, observedAt: now }; };
  const args = { store: empty, concert, resale, mappings, readPage, now };
  const first = await refreshOfficialTickets(args);
  const offers = first.store.entries[concert.id].providerChecks[source.url].offers;
  assert.equal(offers[0].resaleTypeId, 'ts-ga');
  assert.equal(offers[1].resaleTypeId, null);
  const cached = await refreshOfficialTickets({ ...args, store: first.store, now: now + 1 });
  assert.equal(cached.store, first.store);
  assert.equal(reads, 1);
  const broken = await refreshOfficialTickets({
    ...args, store: first.store, now: now + 3600001, mappings: [{ ...mappings[0], category: 'Wrong section' }],
    readPage: async () => { throw new Error('Offline'); }
  });
  const check = broken.store.entries[concert.id].providerChecks[source.url];
  assert.equal(check.status, 'failed');
  assert.equal(check.offers[0].verifiedAt, offers[0].verifiedAt);
  assert.equal(check.offers[0].resaleTypeId, null);

  const manual = recordOfficialOffer(broken.store, concert, resale, {
    concertId: concert.id, seller: 'Official box office', category: 'Standing', quantity: 1,
    purchaseUrl: source.url, sourceUrl: source.url, verifiedAt: new Date(now).toISOString(),
    evidence: 'Manual fallback', availability: 'unknown', currency: 'EUR'
  }, now + 3600010);
  assert.deepEqual(manual.entries[concert.id].providerChecks, broken.store.entries[concert.id].providerChecks);
  const next = await refreshOfficialTickets({ ...args, store: manual, now: now + 7200000 });
  assert.equal(next.store.entries[concert.id].offers[0].evidence, 'Manual fallback');
});

test('publisher Retry-After persists across concerts and runner instances', async () => {
  const reader = createOfficialPageReader({ now: () => now, fetcher: async url => {
    if (url.endsWith('/robots.txt')) return new Response(null, { status: 404 });
    return new Response(null, { status: 429, headers: { 'Retry-After': '7200' } });
  } });
  const first = await refreshOfficialTickets({ store: empty, concert, readPage: reader, now });
  assert.equal(first.store.providerBackoff['tivolivredenburg.nl'], now + 7200000);
  const next = await refreshOfficialTickets({
    store: first.store, concert: { ...concert, id: 'another-concert', date: '2027-02-21' },
    readPage: async () => assert.fail('Publisher should remain on cooldown'), now: now + 4000000
  });
  assert.equal(next.status, 'unavailable');
});
