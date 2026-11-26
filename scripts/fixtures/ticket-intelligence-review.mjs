// Offline browser review only. This file is never loaded by Listening Mirror.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { identity } from '../../js/ticketswap-matching.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:3000';
const root = process.cwd();
const output = process.env.TICKET_REVIEW_OUTPUT || 'docs/ticket-intelligence-review';
const now = Date.now();
const at = days => new Date(now - days * 86400000).toISOString();
const date = new Date(now + 28 * 86400000).toISOString().slice(0, 10);
const sample = {
  id: 'review-barrens', artist: 'Barrens', date, venue: 'TivoliVredenburg', city: 'Utrecht', country: 'NL',
  image: 'https://pelagic-records.com/wp-content/uploads/2020/01/artist_barrens.jpg', ticketUrl: 'https://www.tivolivredenburg.nl/agenda/offline-fixture/'
};
const key = identity(sample);
const event = { id: 'fixture-event', date, url: 'https://www.ticketswap.com/event/offline-fixture' };
const category = {
  id: 'floor', title: 'General admission', availableTickets: 12, activeListings: 8,
  buyerPrices: { low: 3425, high: 4800, median: 3975, listingsCounted: 8 },
  singleTicketOffer: { buyerTotalCents: 3425, url: 'https://www.ticketswap.com/listing/offline-fixture/123' }
};
const offer = {
  seller: 'TivoliVredenburg', category: category.title, verifiedAt: at(.01),
  listedCents: 4500, baseCents: 4500, feesCents: 350, finalCents: 4850, feeInclusive: true,
  currency: 'EUR', availability: 'available', quantity: 1, resaleTypeId: category.id, resaleEventId: event.id,
  sourceUrl: sample.ticketUrl, purchaseUrl: sample.ticketUrl, evidence: 'Offline review fixture',
  equivalenceEvidence: 'Same event, one general admission ticket.'
};
const resale = {
  identity: key, status: 'ok', event, currency: 'EUR', checkedAt: at(.01), complete: true, missingPrices: false,
  availableTickets: 16, lowestPriceCents: 3425,
  market: {
    buyerPrices: { low: 3425, high: 5250, median: 3975, listingsCounted: 10 }, activeListings: 10,
    cheapest: { buyerTotalCents: 3425, sellerCents: 3150, originalCents: 4500, feeDifferenceCents: 275,
      url: category.singleTicketOffer.url },
    categories: [category, { id: 'balcony', title: 'Balcony', availableTickets: 4, activeListings: 2,
      buyerPrices: { low: 5050, high: 5250, median: 5150, listingsCounted: 2 } }]
  },
  marketHistory: [[12, 5300], [9, 4820], [7, 5050], [6, null], [5, 4650], [3, 4080], [1, 3790]]
    .map(([days, lowestPriceCents]) => ({ checkedAt: at(days), lowestPriceCents, complete: true }))
};
const watch = { identity: key, watchId: 'fixture-watch', revision: 'fixture-revision', maxCents: 3800,
  quantity: 2, categoryId: 'floor', paused: false, alerts: ['available', 'threshold', 'drop', 'lastMinute'] };
const privateState = {
  version: 1,
  estimate: { credits: 2, due: 3 },
  entries: { [sample.id]: {
    watchId: watch.watchId, observation: resale,
    soldSample: { eventId: event.id, medianCents: 3850, listingsCounted: 12, observedAt: at(.02) },
    demand: { eventId: event.id, checkedAt: at(.02), title: '38 people waiting', intro: '46 tickets wanted',
      types: [{ id: category.id, title: category.title, priceLevels: [{ text: '12 tickets wanted',
        price: { currency: 'EUR', amount: 3550 } }] }] },
    monitor: { notifications: [{ kind: 'drop', checkedAt: at(.01), buyerCents: 3425 }] }
  } }
};

await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--disable-background-networking']
});
try {
  for (const [width, scenario] of [[320, 'missing'], [375, 'ready'], [412, 'ready'], [768, 'error'], [1280, 'ready']]) {
    const queued = new Map();
    let release;
    const hold = new Promise(done => { release = done; });
    const page = await browser.newPage({
      viewport: { width, height: width >= 768 ? 1020 : 844 }, isMobile: width < 600,
      hasTouch: width < 600, reducedMotion: 'reduce', serviceWorkers: 'block'
    });
    await page.addInitScript(() => {
      localStorage.setItem('lm_going_filter', 'all');
      localStorage.setItem('lm_private_ticket_watch', JSON.stringify({ repository: 'fixture/private-watch', token: 'offline-fixture' }));
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.host === 'api.github.com' && url.pathname.startsWith('/repos/fixture/private-watch')) {
        const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'authorization, accept, x-github-api-version' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (url.pathname === '/repos/fixture/private-watch') return route.fulfill({ headers, json: {
          private: true, visibility: 'private', full_name: 'fixture/private-watch'
        } });
        const data = scenario === 'ready' ? url.pathname.endsWith('ticket-watch-state.json')
          ? privateState : { version: 1, entries: { [sample.id]: watch } } : { version: 1, entries: {} };
        return route.fulfill({ headers, json: {
          sha: 'offline-fixture', content: Buffer.from(JSON.stringify(data)).toString('base64')
        } });
      }
      if (url.host === 'api.github.com' && url.pathname.startsWith('/repos/fixture/mirror/contents/')) {
        const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT, OPTIONS',
          'access-control-allow-headers': 'authorization, accept, x-github-api-version, content-type' };
        const method = route.request().method();
        if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const file = url.pathname.split('/').at(-1);
        const official = file.startsWith('official-');
        const kind = official ? 'official' : 'resale';
        if (method === 'PUT') {
          assert.ok(file.endsWith('-requests.json'));
          const body = JSON.parse(route.request().postData());
          const request = JSON.parse(Buffer.from(body.content, 'base64')).requests[sample.id];
          assert.equal(request.identity, key);
          queued.set(kind, request.requestId);
          return route.fulfill({ headers, json: {} });
        }
        const requestId = queued.get(kind);
        const lastCheck = requestId ? { identity: key, requestId, status: 'verified', lastAttemptAt: new Date().toISOString() } : null;
        const stored = official ? { identity: key, offers: [offer], lastCheck } : { ...resale, requestId };
        const data = file.endsWith('-requests.json') ? { version: 1, requests: {} }
          : { version: 1, updatedAt: new Date().toISOString(), entries: { [sample.id]: stored } };
        return route.fulfill({ headers, json: { sha: 'fixture', content: Buffer.from(JSON.stringify(data)).toString('base64') } });
      }
      const fonts = process.env.TICKET_REVIEW_FONTS;
      if (fonts && url.host === 'fonts.googleapis.com') return route.fulfill({ path: resolve(fonts, 'style.css') });
      if (url.href === sample.image) return route.fulfill({ path: resolve(root, 'assets/artists/barrens.jpg') });
      if (url.origin !== origin) return route.abort();
      if (fonts && /^\/test-fonts\/\d+\.woff2$/.test(url.pathname)) {
        return route.fulfill({ path: resolve(fonts, url.pathname.split('/').at(-1)) });
      }
      if (url.pathname === '/data/artist-images.json') return route.fulfill({ json: {
        artists: { barrens: { name: 'Barrens', image: sample.image } }
      } });
      if (url.pathname === '/data/planned.json') return route.fulfill({ json: { concerts: [sample] } });
      if (['/data/ticketswap.json', '/data/official-ticket-offers.json'].includes(url.pathname)) {
        if (scenario === 'error') {
          await hold;
          return route.fulfill({ status: 503, json: {} });
        }
        const entry = url.pathname.endsWith('/ticketswap.json') ? resale : { identity: key, offers: [offer],
          providerChecks: { fixture: { status: 'verified', offers: [{ ...offer, finalCents: 5050, verifiedAt: at(12) }] } } };
        return route.fulfill({ json: { version: 1, updatedAt: at(0), entries: scenario === 'ready' ? { [sample.id]: entry } : {} } });
      }
      const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(root + sep)) return route.abort();
      try { await readFile(path); return route.fulfill({ path }); } catch { return route.fulfill({ status: 404 }); }
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#panel-concerts [data-v="going"]').click({ timeout: 20000 });
    if (!await page.getByRole('button', { name: 'Ticket Intelligence', exact: true }).count()) {
      await page.locator('#panel-concerts .next-night button').first().click();
    }
    const entry = page.getByRole('button', { name: 'Ticket Intelligence', exact: true }).first();
    await entry.click();
    const dialog = page.getByRole('dialog', { name: 'Barrens', exact: true });
    await dialog.waitFor();
    await dialog.locator('.ti-chrome').evaluate(node => {
      const badge = document.createElement('span');
      badge.textContent = 'OFFLINE FIXTURE';
      badge.style.cssText = 'white-space: nowrap; font: 8px monospace; color: #dfc89b; border: 1px solid #605440; padding: 4px 6px; border-radius: 4px;';
      node.insertBefore(badge, node.lastElementChild);
    });
    await page.evaluate(() => document.fonts.ready);
    await dialog.locator('.ti-artwork').evaluate(img => img.decode());
    assert.ok(await dialog.locator('.ti-artwork').evaluate(img => img.naturalWidth > 0));
    const shot = file => page.screenshot({ path: output + '/' + file + '.jpg', type: 'jpeg', quality: 90 });
    if (scenario === 'error') {
      await dialog.getByText('Loading saved ticket intelligence…').waitFor();
      await shot('06-loading');
      release();
      await dialog.getByText(/Saved TicketSwap results could not be loaded/).waitFor();
      await shot('07-error');
    } else if (scenario === 'missing') {
      await dialog.getByText('No verified price', { exact: true }).waitFor();
      assert.equal(await dialog.locator('.ti-saving').count(), 0);
      await shot('05-missing-data');
    } else {
      await dialog.getByText('TicketSwap · €14.25 less').waitFor();
      await dialog.getByText('Latest alert · Price dropped', { exact: false }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Check TicketSwap' }).count(), 1);
      assert.equal(await dialog.getByRole('button', { name: 'Check official tickets' }).count(), 1);
      if (width === 412) await shot('01-mobile-dashboard');
      if (width === 1280) {
        await shot('02-desktop-modal');
        await dialog.getByRole('button', { name: 'Market', exact: true }).click();
        await dialog.getByText('38 people waiting', { exact: true }).waitFor();
        await shot('08-market-overview');
      }
      await dialog.getByRole('button', { name: 'History', exact: true }).click();
      const point = dialog.locator('.ti-point').first();
      await point.focus();
      assert.match(await dialog.locator('.ti-chart-inspect p').innerText(), /€53.00/);
      if (width === 1280) await shot('03-price-history');
      await dialog.getByLabel('History category').selectOption('floor');
      assert.ok(await dialog.locator('.ti-point').count() > 0);
      await dialog.getByRole('button', { name: 'Watch', exact: true }).click();
      assert.equal(await dialog.getByLabel(/Maximum all-in/).inputValue(), '38.00');
      assert.equal(await dialog.getByLabel('Ticket quantity').inputValue(), '2');
      if (width === 412) await shot('04-watch-configuration');
      assert.equal(queued.size, 0);
      if (width === 1280) {
        await page.evaluate(() => localStorage.setItem('lm_github_config', JSON.stringify({
          owner: 'fixture', repo: 'mirror', token: 'offline-fixture'
        })));
        await dialog.getByRole('button', { name: 'Overview', exact: true }).click();
        const verification = dialog.locator('.ti-verification');
        await verification.getByRole('button', { name: 'Check official tickets' }).click();
        await verification.getByText('Check completed.', { exact: true }).first().waitFor();
        assert.ok(queued.has('official'));
        await verification.getByRole('button', { name: 'Check TicketSwap' }).click();
        await verification.getByText('Check completed.', { exact: true }).nth(1).waitFor();
        assert.ok(queued.has('resale'));
      }
    }
    assert.equal(await page.evaluate(() => innerWidth), width);
    assert.ok(await dialog.locator('.ti-scroll').evaluate(node => node.scrollWidth <= node.clientWidth),
      'Ticket Intelligence overflows at ' + width);
    const scroll = await page.evaluate(() => scrollY);
    if (width === 375) await page.evaluate(() => history.back());
    else await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await entry.evaluate(node => node === document.activeElement));
    assert.equal(await page.evaluate(() => scrollY), scroll);
    await page.close();
    console.log('Offline application review passed', width, scenario);
  }
} finally {
  await browser.close();
}
