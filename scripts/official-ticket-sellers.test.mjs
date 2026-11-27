// V2.4.3 regression tests: ticket-link classification, seller resolution
// without traversing robots-disallowed intermediaries, event matching,
// provider adapters on markup captured in the 2026-11-26 live audit, caching,
// price history and failure handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyTicketLink, cleanTicketURL, sellerSummary, verifiedSellerLink } from '../js/ticket-links.js';
import { knownOfficialLink } from '../js/ticket-official.js';
import { identity } from '../js/ticketswap-matching.js';
import { ticketHistory } from '../js/ticket-intelligence-model.js';
import { createOfficialPageReader, PublisherBackoff, RobotsDisallowed } from './sources/official-ticket-http.mjs';
import { pickSeller, resolveOfficialSeller, sellerIsCurrent, sellerLinksOnPage, SELLER_RESOLVED_TTL_MS }
  from './sources/official-ticket-sellers.mjs';
import { officialTicketSources, parseOfficialTicketPage } from './sources/official-ticket-providers.mjs';
import { refreshOfficialTickets } from './lib/official-ticket-refresh.mjs';

const live = JSON.parse(await readFile(new URL('./fixtures/official-ticket-live-2026-11-26.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-11-26T22:00:00Z');
const ld = event => `<script type="application/ld+json">${JSON.stringify(event)}</script>`;

// ---------- classification ----------

test('ticket links are classified as intermediary, resale, official seller or unknown', () => {
  const podium = classifyTicketLink('https://www.podiuminfo.nl/ticket/132190/cd/MONO/TivoliVredenburg/');
  assert.equal(podium.kind, 'intermediary');
  assert.match(podium.robots, /Disallow: \/ticket/);
  assert.equal(classifyTicketLink('https://www.festivalinfo.nl/ticket/135659/df/Roadburn-2027/').kind, 'intermediary');
  assert.equal(classifyTicketLink('https://www.podiuminfo.nl/ticketswap/333976/MONO/TivoliVredenburg/').kind, 'resale');
  assert.equal(classifyTicketLink('https://www.ticketswap.nl/event/mono/abc').kind, 'resale');
  assert.equal(classifyTicketLink('https://www.podiuminfo.nl/concert/459758/MONO/TivoliVredenburg/').kind, 'unknown');
  const tm = classifyTicketLink('https://www.ticketmaster.nl/event/1071853401?brand=nl_patronaat&utm_source=x&fbclid=y');
  assert.deepEqual([tm.kind, tm.provider, tm.url],
    ['official-seller', 'ticketmaster', 'https://www.ticketmaster.nl/event/1071853401?brand=nl_patronaat']);
  assert.equal(classifyTicketLink('https://www.ticketmaster.nl/artist/megadeth-tickets/1236?venueId=4247').kind, 'unknown');
  assert.equal(classifyTicketLink('https://www.ticketmaster.nl/event/1/resale').kind, 'resale');
  for (const [url, provider] of [
    ['https://tickets.013.nl/e092e5e1864a48abbe4ddf6d6e06e49a', '013-tickets'],
    ['https://tickets.paradiso.nl/7a68e4c375754bbea06e66413eeec6e1', 'paradiso-tickets'],
    ['https://tickets.parallel.am/e76beb4ade5549688937ade262a3b4d9', 'parallel-tickets'],
    ['https://ticketshop.doornroosje.nl/2f540e74a2064cbc8169369898244e8a', 'doornroosje-tickets'],
    ['https://muziekgieterij.stager.co/shop/concert/events/111698497', 'stager']
  ]) assert.equal(classifyTicketLink(url).provider, provider, url);
  assert.equal(classifyTicketLink('https://order.doornroosje.nl/5145b574a76e40b79f60a80bbfff143a/tickets').kind, 'unknown');
  assert.equal(classifyTicketLink('https://account.paradiso.nl/31f8b2241aa24dad815bbbf0d356a099/orders').kind, 'unrelated');
  assert.equal(classifyTicketLink('https://tickets.013.nl.example.invalid/e092e5e1864a48abbe4ddf6d6e06e49a').kind, 'unknown');
  assert.equal(classifyTicketLink('https://user:pw@tickets.013.nl/e092e5e1864a48abbe4ddf6d6e06e49a').kind, 'invalid');
  assert.equal(cleanTicketURL('http://www.013.nl/programma/1?lang=en&gclid=1#tickets'), 'https://www.013.nl/programma/1?lang=en');
});

// ---------- seller links on venue pages ----------

test('only the main content ticket for the night counts as the seller link', () => {
  const page = `<nav><a href="https://www.ticketmaster.nl/event/999">Other night</a></nav><main>
    <a href="https://www.ticketmaster.nl/event/megadeth-tour-tickets/1372783969?language=en-us">tickets</a>
    <a href="https://www.ticketmaster.nl/event/397220963">premium tickets</a>
    <a href="https://www.ticketmaster.nl/artist/megadeth-tickets/1236">KOOP KAARTEN</a>
    <a href="https://www.ticketmaster.nl/event/555">Een parkeerticket koop je hier</a></main>`;
  const links = sellerLinksOnPage(page, 'https://www.afaslive.nl/agenda/megadeth');
  assert.deepEqual(links.map(link => link.url), ['https://www.ticketmaster.nl/event/megadeth-tour-tickets/1372783969?language=en-us']);
  assert.equal(pickSeller(links).provider, 'ticketmaster');
  const waitlist = sellerLinksOnPage('<main><a href="https://tickets.paradiso.nl/7a68e4c375754bbea06e66413eeec6e1">WachtlijstTicket € 55,40</a></main>', 'https://www.paradiso.nl/');
  assert.deepEqual([waitlist[0].state, waitlist[0].priceCents], ['waitlist', 5540]);
  const two = sellerLinksOnPage('<main><a href="https://tickets.013.nl/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Dag 1</a><a href="https://tickets.013.nl/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">Dag 2</a></main>', 'https://www.013.nl/');
  assert.equal(pickSeller(two), null);
});

// ---------- resolution ----------

const amorphis = {
  id: 'planned-podiuminfo-467043', artist: 'Amorphis', date: '2027-02-14', venue: '013', city: 'Tilburg', country: 'NL',
  ticketUrl: 'https://www.podiuminfo.nl/ticket/131000/cd/Amorphis/013/',
  schedule: { sources: [{ kind: 'official', url: 'https://www.013.nl/programma/131462/amorphis' }] }
};
const page013 = `<html><main><h1>Amorphis</h1>${live['013']}</main>${ld({ '@type': 'Event', name: 'Amorphis Borderland tour - 14 februari', startDate: '2027-02-14T19:30:00+01:00' })}</html>`;

function fakeReader(pages, { robots = () => true } = {}) {
  const fetched = [];
  return {
    fetched,
    robotsAllowed: async url => robots(url),
    fetchPage: async (url, hosts) => {
      fetched.push(url);
      assert.ok(!/\/ticket\//.test(new URL(url).pathname) || !/podiuminfo|festivalinfo/.test(url), 'intermediary fetched');
      const result = pages[url];
      if (result instanceof Error) throw result;
      if (!result) throw new Error('Official publisher page unavailable');
      assert.ok(hosts.includes(new URL(url).hostname.replace(/^www\./, '')));
      return { html: result, url, observedAt: now };
    }
  };
}

test('an intermediary link is never traversed; the seller comes from the verified venue page', async () => {
  const reader = fakeReader({ 'https://www.013.nl/programma/131462/amorphis': page013 },
    { robots: url => !/podiuminfo\.nl\/ticket\//.test(url) });
  const discover = async () => assert.fail('stored official page should be enough');
  const seller = await resolveOfficialSeller({ concert: amorphis, reader, discover, now });
  assert.equal(seller.status, 'resolved');
  assert.equal(seller.provider, '013-tickets');
  assert.equal(seller.purchaseUrl, 'https://tickets.013.nl/e092e5e1864a48abbe4ddf6d6e06e49a');
  assert.equal(seller.eventPageUrl, 'https://www.013.nl/programma/131462/amorphis');
  assert.deepEqual(seller.intermediary, { provider: 'podiuminfo', url: amorphis.ticketUrl, traversed: false,
    reason: 'robots-disallowed (Disallow: /ticket/*)' });
  assert.equal(seller.identity, identity(amorphis));
  assert.deepEqual(reader.fetched, ['https://www.013.nl/programma/131462/amorphis']);
});

test('event identity: another date or artist on the venue page is not this concert', async () => {
  for (const change of [{ date: '2027-02-15' }, { artist: 'Insomnium' }]) {
    const concert = { ...amorphis, ...change };
    const reader = fakeReader({ 'https://www.013.nl/programma/131462/amorphis': page013 });
    const seller = await resolveOfficialSeller({ concert, reader, discover: async () => [], now });
    assert.equal(seller.status, 'unresolved', JSON.stringify(change));
    assert.match(seller.reason, /identity-unverified/);
    assert.equal(seller.purchaseUrl, undefined);
  }
});

test('discovery is used when stored pages fail, and failures are reported honestly', async () => {
  const fresh = { ...amorphis, schedule: null };
  const reader = fakeReader({ 'https://www.013.nl/programma/131462/amorphis': page013 });
  const found = await resolveOfficialSeller({ concert: fresh, reader, now,
    discover: async () => ['https://www.013.nl/programma/131462/amorphis?utm_source=sitemap'] });
  assert.equal(found.status, 'resolved');

  const blocked = fakeReader({ 'https://www.013.nl/programma/131462/amorphis': new PublisherBackoff(now + 3600000, 'access-control') });
  assert.equal((await resolveOfficialSeller({ concert: amorphis, reader: blocked, discover: async () => [], now })).status, 'blocked');
  const robots = fakeReader({ 'https://www.013.nl/programma/131462/amorphis': new RobotsDisallowed('x') });
  assert.equal((await resolveOfficialSeller({ concert: amorphis, reader: robots, discover: async () => [], now })).status, 'robots-disallowed');
  const unsupported = await resolveOfficialSeller({ concert: { ...amorphis, venue: 'Unknown Club' }, reader, discover: async () => [], now });
  assert.equal(unsupported.status, 'unsupported-venue');
  const ambiguous = fakeReader({ 'https://www.013.nl/programma/131462/amorphis': page013.replace('</main>',
    '<a href="https://tickets.013.nl/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">Tickets dag 2</a></main>') });
  assert.equal((await resolveOfficialSeller({ concert: amorphis, reader: ambiguous, discover: async () => [], now })).status, 'ambiguous');
});

test('a stored official seller link resolves directly without any request', async () => {
  const concert = { ...amorphis, ticketUrl: 'https://www.ticketmaster.nl/event/96022984?brand=nl_patronaat&utm_medium=x' };
  const reader = fakeReader({});
  const seller = await resolveOfficialSeller({ concert, reader, discover: async () => assert.fail(), now });
  assert.deepEqual([seller.status, seller.method, seller.purchaseUrl],
    ['resolved', 'direct', 'https://www.ticketmaster.nl/event/96022984?brand=nl_patronaat']);
  assert.equal(reader.fetched.length, 0);
});

// ---------- caching ----------

test('a cached seller is reused for its identity and ticket link, then expires', async () => {
  const reader = fakeReader({ 'https://www.013.nl/programma/131462/amorphis': page013 });
  const seller = await resolveOfficialSeller({ concert: amorphis, reader, discover: async () => [], now });
  const record = { identity: identity(amorphis), seller };
  assert.equal(sellerIsCurrent(record, amorphis, now + 1000), true);
  assert.equal(sellerIsCurrent(record, amorphis, now + SELLER_RESOLVED_TTL_MS + 1), false);
  assert.equal(sellerIsCurrent(record, { ...amorphis, date: '2027-02-15' }, now + 1000), false);
  assert.equal(sellerIsCurrent(record, { ...amorphis, ticketUrl: 'https://www.podiuminfo.nl/ticket/9/cd/x/' }, now + 1000), false);
  assert.equal(sellerIsCurrent({ seller: { ...seller, status: 'unresolved' } }, amorphis, now + 2 * 86400000), false);
});

test('refresh resolves once, reads the seller-derived source and accumulates price history', async () => {
  let resolutions = 0;
  const resolveSeller = async () => {
    resolutions++;
    return resolveOfficialSeller({ concert: amorphis, reader: fakeReader({ 'https://www.013.nl/programma/131462/amorphis': page013 }), discover: async () => [], now });
  };
  const readPage = async source => ({ html: page013, url: source.url, observedAt: Date.parse(source.observedAt ?? '') || stamp });
  let stamp = now;
  const first = await refreshOfficialTickets({ store: { version: 1, entries: {} }, concert: { ...amorphis, schedule: null }, readPage, resolveSeller, now });
  const record = first.store.entries[amorphis.id];
  assert.equal(record.seller.status, 'resolved');
  const [offer] = Object.values(record.providerChecks)[0].offers;
  assert.deepEqual([offer.provider, offer.listedCents, offer.finalCents, offer.purchaseUrl],
    ['013-event-page', 4230, null, 'https://tickets.013.nl/e092e5e1864a48abbe4ddf6d6e06e49a']);
  assert.deepEqual(offer.priceContext, { serviceFeesIncluded: true });
  assert.equal(record.history.length, 1);

  stamp = now + 2 * 3600000;
  const second = await refreshOfficialTickets({ store: first.store, concert: { ...amorphis, schedule: null }, readPage, resolveSeller, now: stamp });
  assert.equal(resolutions, 1);
  assert.equal(second.store.entries[amorphis.id].history.length, 2);
  const unchanged = await refreshOfficialTickets({ store: second.store, concert: { ...amorphis, schedule: null }, readPage, resolveSeller, now: stamp + 1 });
  assert.equal(unchanged.store, second.store);

  const failing = await refreshOfficialTickets({ store: second.store, concert: { ...amorphis, schedule: null }, readPage,
    resolveSeller: async () => { throw new Error('offline'); }, now: stamp + SELLER_RESOLVED_TTL_MS + 1 });
  assert.equal(failing.store.entries[amorphis.id].seller.purchaseUrl, record.seller.purchaseUrl);
});

// ---------- provider adapters on captured live markup ----------

const source = (url, extra = {}) => ({ url, domain: new URL(url).hostname.replace(/^www\./, ''), provider: 'venue-jsonld', label: new URL(url).hostname, ...extra });

test('013 price table: advertised price incl. service fees, never an all-in total', () => {
  const [offer] = parseOfficialTicketPage(page013, amorphis, source('https://www.013.nl/programma/131462/amorphis'), now);
  assert.deepEqual([offer.seller, offer.listedCents, offer.feesCents, offer.finalCents, offer.feeInclusive, offer.availability],
    ['013', 4230, null, null, false, 'unknown']);
  assert.deepEqual(parseOfficialTicketPage(page013.replace("feb &#039;27", "feb &#039;28"), amorphis, source('https://www.013.nl/programma/131462/amorphis'), now), []);
});

test('Doornroosje button price and shop link, identity from the page event', () => {
  const concert = { id: 'x', artist: 'The Ocean', date: '2027-01-27', venue: 'Doornroosje', city: 'Nijmegen', country: 'NL' };
  const html = `<main><h1>The Ocean</h1>${live.doornroosje}</main>${ld({ '@type': 'Event', name: 'The Ocean + A.A. Williams', startDate: '2027-01-27T20:15:00+00:00', location: { '@type': 'Place', name: 'Doornroosje - Rode zaal', address: { addressLocality: '' } } })}`;
  const [offer] = parseOfficialTicketPage(html, concert, source('https://www.doornroosje.nl/event/the-ocean-3/'), now);
  assert.deepEqual([offer.listedCents, offer.purchaseUrl, offer.availability],
    [3100, 'https://ticketshop.doornroosje.nl/2f540e74a2064cbc8169369898244e8a', 'unknown']);
  assert.deepEqual(parseOfficialTicketPage(html, { ...concert, date: '2027-01-28' }, source('https://www.doornroosje.nl/event/the-ocean-3/'), now), []);
});

test('AFAS Live categories for the matching date, Ticketmaster event link kept with its parameters', () => {
  const concert = { id: 'x', artist: 'Megadeth', date: '2027-03-24', venue: 'AFAS Live', city: 'Amsterdam', country: 'NL' };
  const html = `<main><h1>Megadeth</h1><p>woensdag 24 maart 2027</p>${live.afas}</main>`;
  const offers = parseOfficialTicketPage(html, concert, source('https://www.afaslive.nl/agenda/megadeth'), now);
  assert.deepEqual(offers.map(offer => [offer.category, offer.listedCents]), [['General Admission', 10098], ['Rolstoelplatform', 10098]]);
  assert.equal(offers[0].seller, 'Ticketmaster');
  assert.match(offers[0].purchaseUrl, /^https:\/\/www\.ticketmaster\.nl\/event\/megadeth-[^?]+\/1372783969\?language=en-us$/);
  assert.deepEqual(offers[0].priceContext, { serviceFeesIncluded: true });
  assert.deepEqual(parseOfficialTicketPage(html.replace('24 maart 2027</date>', '25 maart 2027</date>'), concert, source('https://www.afaslive.nl/agenda/megadeth'), now), []);
});

test('Paradiso/Parallel event record: base price, service fee, stock state and shop', () => {
  const concert = { id: 'x', artist: 'Scientist', date: '2027-02-11', venue: 'Parallel', city: 'Amsterdam', country: 'NL' };
  const html = `<script type="application/ld+json">${live.parallelLd}</script><main><h1>Scientist</h1></main><script>self.__next_f.push([1,"${live.parallelRecord}"])</script>`;
  const url = 'https://www.paradiso.nl/programma/scientist/2938907';
  const [offer] = parseOfficialTicketPage(html, concert, source(url), now);
  assert.deepEqual([offer.seller, offer.baseCents, offer.feesCents, offer.listedCents, offer.finalCents, offer.availability],
    ['Parallel', 2100, 250, 2350, null, 'available']);
  assert.equal(offer.purchaseUrl, 'https://tickets.parallel.am/e76beb4ade5549688937ade262a3b4d9');
  const soldOut = html.replace('\\"soldOut\\":\\"no\\"', '\\"soldOut\\":\\"yes\\"');
  assert.equal(parseOfficialTicketPage(soldOut, concert, source(url), now)[0].availability, 'sold-out');
  assert.deepEqual(parseOfficialTicketPage(html, concert, source('https://www.paradiso.nl/programma/other/1'), now), []);
});

test('Ziggo Dome public data: categories, OnSale state and named seller; wrong night rejected', () => {
  const concert = { id: 'x', artist: 'Nothing But Thieves', date: '2027-01-15', venue: 'Ziggo Dome', city: 'Amsterdam', country: 'NL',
    schedule: { sources: [{ kind: 'official', url: 'https://www.ziggodome.nl/events/eabea2f5-b7a4-492d-a008-acf4b9289b0a/' }] } };
  const [src] = officialTicketSources(concert);
  assert.deepEqual([src.provider, src.url, src.mediaType], ['ziggodome-api',
    'https://www.ziggodome.nl/api/agenda/events/eabea2f5-b7a4-492d-a008-acf4b9289b0a', 'application/json']);
  const [offer] = parseOfficialTicketPage(JSON.stringify(live.ziggo), concert, src, now);
  assert.deepEqual([offer.seller, offer.category, offer.listedCents, offer.availability, offer.sourceUrl],
    ['Ticketmaster', 'Tickets', 5040, 'available', 'https://www.ziggodome.nl/events/eabea2f5-b7a4-492d-a008-acf4b9289b0a/']);
  assert.deepEqual(parseOfficialTicketPage(JSON.stringify(live.ziggo), { ...concert, date: '2027-01-16' }, src, now), []);
  assert.deepEqual(parseOfficialTicketPage(JSON.stringify(live.ziggo), { ...concert, artist: 'Deep Purple' }, src, now), []);
});

// ---------- transport ----------

test('robots.txt redirects are followed; challenges back off as access control; requests are paced', async () => {
  const calls = [];
  const waits = [];
  let clock = now;
  const reader = createOfficialPageReader({
    now: () => clock, delayMs: 1000, sleep: async ms => { waits.push(ms); clock += ms; },
    fetcher: async url => {
      calls.push(url);
      if (url === 'https://013.nl/robots.txt') return new Response(null, { status: 301, headers: { location: 'https://www.013.nl/robots.txt' } });
      if (url === 'https://www.013.nl/robots.txt') return new Response('User-agent: *\nDisallow: /cpresources/', { headers: { 'content-type': 'text/plain' } });
      if (url.includes('tivolivredenburg')) return url.endsWith('robots.txt') ? new Response(null, { status: 404 })
        : new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
      return new Response('<main>ok</main>', { headers: { 'content-type': 'text/html' } });
    }
  });
  assert.equal((await reader.fetchPage('https://013.nl/programma/1', ['013.nl'])).html, '<main>ok</main>');
  await assert.rejects(reader.fetchPage('https://013.nl/cpresources/x', ['013.nl']), RobotsDisallowed);
  await assert.rejects(reader.fetchPage('https://www.tivolivredenburg.nl/agenda/1', ['tivolivredenburg.nl']),
    error => error instanceof PublisherBackoff && error.reason === 'access-control');
  await assert.rejects(reader.fetchPage('https://www.tivolivredenburg.nl/agenda/2', ['tivolivredenburg.nl']), PublisherBackoff);
  assert.equal(calls.filter(url => url.includes('/agenda/')).length, 1);
  await assert.rejects(reader.fetchPage('https://evil.example/programma', ['013.nl']), /Unapproved/);
  assert.ok(waits.length >= 1 && waits.every(ms => ms <= 1000));
  assert.equal(await reader.robotsAllowed('https://013.nl/programma/1'), true);
});

test('an unreachable robots.txt is reported as unavailable, never as the publisher policy, and is retried', async () => {
  let robotsCalls = 0;
  const reader = createOfficialPageReader({ fetcher: async url => {
    if (url.endsWith('/robots.txt')) {
      robotsCalls++;
      if (robotsCalls === 1) throw new TypeError('fetch failed');
      return new Response('User-agent: *\nAllow: /', { headers: { 'content-type': 'text/plain' } });
    }
    return new Response('<main>ok</main>', { headers: { 'content-type': 'text/html' } });
  } });
  await assert.rejects(reader.fetchPage('https://www.vera-groningen.nl/events/x', ['vera-groningen.nl']),
    error => !(error instanceof RobotsDisallowed) && /unreachable/.test(error.message));
  assert.equal((await reader.fetchPage('https://www.vera-groningen.nl/events/y', ['vera-groningen.nl'])).html, '<main>ok</main>');
  assert.equal(robotsCalls, 2);
});

// ---------- dashboard ----------

test('the dashboard links only verified destinations and explains unresolved sellers', () => {
  const key = identity(amorphis);
  const seller = { identity: key, status: 'resolved', method: 'venue-event-page', provider: '013-tickets', seller: '013',
    purchaseUrl: 'https://tickets.013.nl/e092e5e1864a48abbe4ddf6d6e06e49a', eventPageUrl: 'https://www.013.nl/programma/131462/amorphis' };
  assert.equal(knownOfficialLink(amorphis, { identity: key, seller }), seller.purchaseUrl);
  assert.equal(knownOfficialLink(amorphis, { identity: 'other', seller }), null);
  assert.equal(knownOfficialLink(amorphis, { identity: key, seller: { ...seller, status: 'unresolved' } }), null);
  assert.equal(knownOfficialLink(amorphis, { identity: key, seller: { ...seller, purchaseUrl: 'https://www.podiuminfo.nl/ticket/1/' } }), null);
  const page = { ...seller, provider: 'venue-event-page', purchaseUrl: seller.eventPageUrl };
  assert.equal(verifiedSellerLink({ identity: key, seller: page }, key).purchaseUrl, seller.eventPageUrl);
  assert.equal(verifiedSellerLink({ identity: key, seller: { ...page, purchaseUrl: 'https://example.org/x' } }, key), null);
  assert.equal(sellerSummary({ identity: key, seller }, key, amorphis.ticketUrl).text, '013 · via verified 013.nl page');
  assert.equal(sellerSummary(null, key, amorphis.ticketUrl).text,
    'Official seller not verified: not yet checked. The Podiuminfo link is not followed (robots policy).');
  assert.match(sellerSummary({ identity: key, seller: { identity: key, status: 'blocked' } }, key, null).text, /blocks automated checks/);
});

test('advertised official observations form their own history series, never the all-in line', () => {
  const offer = { seller: '013', category: 'Category not stated', currency: 'EUR', listedCents: 4230, feeInclusive: false, verifiedAt: '2026-11-26T22:00:00Z', quantity: 1 };
  const evidence = { resale: null, offer, offers: [offer], watch: null, officialRecord: { history: [
    { at: '2026-11-25T22:00:00Z', seller: '013', category: 'Category not stated', currency: 'EUR', listedCents: 3990, feeInclusive: false },
    { at: '2026-11-24T22:00:00Z', seller: 'Other', category: 'Category not stated', currency: 'EUR', listedCents: 1000, feeInclusive: false }
  ] } };
  const series = ticketHistory(evidence);
  assert.deepEqual(series.map(group => group.id), ['resale', 'official', 'official-listed']);
  assert.deepEqual(series[1].points, []);
  assert.deepEqual(series[2].points.map(point => point.cents), [3990, 4230]);
});
