import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichOne } from './enrich-concert-schedules.mjs';
import { parseSchedule, mergeSchedule } from './sources/concert-schedule.mjs';

const root = 'https://tivolivredenburg.nl';
const c = {
  id:'test-tivoli', artist:'José González', date:'2026-11-23',
  venue:'TivoliVredenburg', country:'NL', city:'Utrecht'
};
const url = root + '/agenda/40280132/jose-gonzalez-23-11-2026';
const now = '2026-10-26T20:00:00Z';

const page = (
  artist=c.artist, date=c.date, support='Nog niet bekend'
) => `<title>${artist} – TivoliVredenburg</title>
<main><h2>${artist}</h2><time datetime="${date}"></time>
<dl>
<dd>19:00</dd><dt class="description-list__term--group">Deuren open</dt>
<dd>20:00</dd><dt class="description-list__term--group">Aanvang</dt>
<dt>Support act</dt><dd>${support}</dd>
</dl></main>`;

test('current production feed is reached before taxonomy maps exhaust the budget', async () => {
  for (const artist of [c.artist, 'Another Artist']) {
    const calls = [];
    const slug = artist.normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const event = root + '/agenda/123/' + slug + '-23-11-2026';
    const feed = root + '/seo-feed/sf-production-sitemap-xml';

    const fetcher = async path => {
      calls.push(path);
      if (path === root + '/sitemap_index.xml') {
        const categories = Array.from({length:10}, (_,i) =>
          `<sitemap><loc>${root}/event_category-${i}-sitemap.xml</loc></sitemap>`
        ).join('');
        return {
          url:path,
          html:`<sitemapindex>${categories}<sitemap><loc>${feed}</loc></sitemap></sitemapindex>`
        };
      }
      if (path === feed) {
        return {
          url:path,
          html:`<urlset><url><loc>${event}</loc></url></urlset>`
        };
      }
      if (path === event) return {url:path, html:page(artist)};
      throw Error('HTTP 404');
    };

    const s = await enrichOne({...c, artist}, now, 'manual', fetcher);
    assert.equal(s.checkStatus, 'official');
    assert.equal(s.doors.time, '19:00');
    assert.equal(s.start.time, '20:00');
    assert.equal(s.main.time, null);
    assert.ok(calls.includes(feed));
    assert.ok(!calls.some(p => p.includes('event_category-')));
  }
});

test('unknown support keeps programme start separate from main act', () => {
  const s = mergeSchedule(c, [parseSchedule(page(), c, url)], now, 'manual');
  assert.equal(s.start.time, '20:00');
  assert.equal(s.start.unassigned, true);
  assert.equal(s.main.time, null);
  assert.deepEqual(s.support, []);
});

test('confirmed no-support and named support retain their existing assignment', () => {
  const solo = mergeSchedule(c, [
    parseSchedule(page(c.artist, c.date, 'Geen voorprogramma'), c, url)
  ], now, 'manual');
  assert.equal(solo.main.time, '20:00');

  const support = mergeSchedule(c, [
    parseSchedule(page(c.artist, c.date, 'Guest Band'), c, url)
  ], now, 'manual');
  assert.equal(support.support[0].time, '20:00');
  assert.equal(support.main.time, null);
});

test('wrong concert dates and artists remain rejected', () => {
  assert.equal(parseSchedule(page(c.artist, '2026-11-24'), c, url), null);
  assert.equal(parseSchedule(page('Another Artist'), c, url), null);
});
