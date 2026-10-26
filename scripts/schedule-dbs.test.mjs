import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, mergeSchedule, venueConfig } from './sources/concert-schedule.mjs';
import { enrichOne } from './enrich-concert-schedules.mjs';

const c = {
  id: 'dbs-test', artist: 'Pro-Pain', date: '2026-11-17',
  venue: "dB's", city: 'Utrecht', country: 'NL'
};
const url = 'https://dbstudio.nl/event/pro-pain-usa-legends/';
const now = '2026-10-26T00:00:00Z';

function html({
  artist = 'PRO-PAIN (USA – Legends) + Dyslekt',
  date = '2026-11-17',
  performer = 'Organization'
} = {}) {
  const event = {
    '@type': 'Event', name: artist,
    startDate: date + 'T20:00:00+01:00',
    endDate: date + 'T23:00:00+01:00',
    performer
  };
  return `<html><head>
    <title>${artist} – dB's Studio</title>
    <meta property="og:title" content="${artist}">
    <script type="application/ld+json">${JSON.stringify(event)}</script>
    </head><body><main>
    <div class="dbstudio-event-meta"><div><strong>Datum</strong><span>17 november 2026</span></div><div><strong>Aanvang</strong><span>20:00 uur</span></div><div><strong>Einde</strong><span>23:00 uur</span></div></div>
    </main></body></html>`;
}

test("dB's exposes programme start, end and support without inventing act times", () => {
  const result = parseSchedule(html(), c, url);
  assert.ok(result);
  const schedule = mergeSchedule(c, [result], now, 'manual');
  assert.equal(schedule.start.time, '20:00');
  assert.equal(schedule.start.unassigned, true);
  assert.equal(schedule.end.time, '23:00');
  assert.equal(schedule.main.time, null);
  assert.equal(schedule.doors.time, null);
  assert.deepEqual(
    schedule.support.map(a => [a.name, a.time]),
    [['Dyslekt', null]]
  );
});

test('visible date and title fallback work without structured metadata', () => {
  const page = html()
    .replace(/<script[\s\S]*?<\/script>/, '')
    .replace(/<meta[^>]+>/, '');
  const result = parseSchedule(page, c, url);
  assert.ok(result);
  assert.equal(result.values.start.time, '20:00');
  assert.deepEqual(result.supportNames, ['Dyslekt']);
});

test('wrong date, artist and real performer remain rejected', () => {
  for (const options of [
    { date: '2026-11-18' },
    { artist: 'Another Band' },
    { performer: { name: 'Another Band' } }
  ]) {
    assert.equal(parseSchedule(html(options), c, url), null);
  }
});

test('the placeholder exception applies only to dB’s', () => {
  assert.equal(
    parseSchedule(html(), c, 'https://patronaat.nl/event/pro-pain/'),
    null
  );
});

test("dB's agenda discovery works for different bands", async () => {
  assert.equal(venueConfig(c)[2], '/agenda/');
  for (const artist of ['Pro-Pain', 'Example Band']) {
    const concert = { ...c, artist };
    const fetcher = async page => {
      if (page === 'https://dbstudio.nl/agenda/') {
        return { url: page, html: `<a href="${url}">${artist}</a>` };
      }
      if (page === url) {
        return {
          url,
          html: html({ artist: artist + ' + Another Support' })
        };
      }
      throw Error('Unexpected source');
    };
    const schedule = await enrichOne(concert, now, 'manual', fetcher);
    assert.equal(schedule.checkStatus, 'official');
    assert.equal(schedule.start.time, '20:00');
    assert.equal(schedule.end.time, '23:00');
    assert.equal(schedule.main.time, null);
    assert.deepEqual(
      schedule.support.map(a => a.name), ['Another Support']
    );
  }
});
