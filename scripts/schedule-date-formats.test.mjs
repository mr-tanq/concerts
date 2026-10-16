import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, enrichOne } from './enrich-concert-schedules.mjs';

const c = {
  id: 'date-test', artist: 'Example Band', date: '2026-10-24',
  venue: 'Patronaat', city: 'Haarlem', country: 'NL',
  supportingArtists: []
};
const url = 'https://patronaat.nl/event/example-band/';
const html = date => `<main><h1>Example Band</h1>
  <div> ${date} </div>
  <div> Deuren: 19:30 </div>
  <div> Start: 20:00 </div>
</main>`;

test('Dutch and English abbreviated months validate complete dates', () => {
  const months = [
    ['jan', 'Jan.'], ['feb', 'Feb.'], ['mrt', 'mar'], ['apr', 'Apr.'],
    ['mei', 'may'], ['jun', 'Jun.'], ['jul', 'Jul.'], ['aug', 'Aug.'],
    ['sep', 'sept'], ['okt', 'oct'], ['nov', 'Nov.'], ['dec', 'Dec.']
  ];

  for (let i = 0; i < months.length; i++) {
    const concert = {
      ...c,
      date: `2027-${String(i + 1).padStart(2, '0')}-24`
    };
    for (const month of months[i]) {
      const parsed = parseSchedule(
        html(`24 ${month} 2027`), concert, url
      );
      assert.ok(parsed, month);
      assert.equal(parsed.values.doors.time, '19:30');
      assert.equal(parsed.values.main, undefined);
    }
  }

  assert.equal(parseSchedule(html('25 okt 2026'), c, url), null);
  assert.equal(parseSchedule(html('24 okt 2027'), c, url), null);
  assert.equal(parseSchedule(html('24 okt'), c, url), null);
});

test('agenda discovery reads doors without inventing performance times', async () => {
  const fetcher = async page => {
    if (page === 'https://patronaat.nl/programma/') {
      return { url: page, html: `<a href="${url}">Example Band</a>` };
    }
    if (page === url) {
      return { url, html: html('za 24 okt 2026') };
    }
    throw new Error('Unexpected source');
  };

  const s = await enrichOne(
    c, '2026-10-16T08:50:00Z', 'manual', fetcher
  );

  assert.equal(s.checkStatus, 'official');
  assert.equal(s.doors.time, '19:30');
  assert.equal(s.main.time, '20:00');
  assert.equal(s.end.time, null);
  assert.equal(s.sources[0].url, url);
});
