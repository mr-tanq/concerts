import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, mergeSchedule } from './enrich-concert-schedules.mjs';
import { scheduleMarkup, scheduleCountdown } from '../js/concert-schedule.js';

const c = {
  id: 'row-test', artist: 'Example Band', date: '2026-11-03',
  venue: '013', country: 'NL', supportingArtists: []
};
const url = 'https://www.013.nl/programma/example';
const stamp = '2026-10-16T09:00:00Z';
const page = rows => `<main><h1>Example Band</h1>
  <time datetime="2026-11-03">3 nov 2026</time>${rows}</main>`;
const parse = rows => parseSchedule(page(rows), c, url, 'official', stamp);

test('list and table rows accept either time-label orientation', () => {
  for (const tag of ['li', 'tr', 'div']) {
    for (const reversed of [false, true]) {
      const row = (label, time) => {
        const values = reversed ? [label, time] : [time, label];
        const cell = tag === 'tr' ? 'td' : 'span';
        return `<${tag}${tag === 'div' ? ' role="row"' : ''}>`
          + values.map(x => `<${cell}>${x}</${cell}>`).join('')
          + `</${tag}>`;
      };
      const rows = row('Zaal open', '19:00')
        + row('Aanvang', '20:00') + row('Einde', '22:30');
      const r = parse(tag === 'tr' ? `<table>${rows}</table>` : rows);
      assert.equal(r.values.doors.time, '19:00');
      assert.equal(r.values.start.time, '20:00');
      assert.equal(r.values.end.time, '22:30');
      assert.equal(r.values.main, undefined);
    }
  }
});

test('programme start follows the selected act rule', () => {
  const s = mergeSchedule(c, [
    parse('<p>Doors 19:00</p><p>Start 20:00</p>')
  ], stamp, 'manual');
  const concert = { ...c, schedule: s };
  assert.equal(s.main.time, '20:00');
  assert.ok(!scheduleMarkup(concert).includes('PROGRAMME START'));
  assert.equal(
    scheduleCountdown(concert, Date.parse('2026-11-03T18:30:00Z')),
    'EXAMPLE BAND IN 30M'
  );
  assert.equal(
    mergeSchedule(concert, [], '2026-10-16T10:00:00Z', 'manual').start.time,
    '20:00'
  );
});

test('plus-billed support is kept with an unknown time', () => {
  const html = page('').replace('<h1>Example Band</h1>',
    '<div><h1>Example Band</h1><ul><li>+ Guest Act</li></ul></div>');
  const r = parseSchedule(html, c, url, 'official', stamp);
  const s = mergeSchedule(c, [r], stamp, 'manual');
  assert.equal(s.support[0].name, 'Guest Act');
  assert.equal(s.support[0].time, null);
});

test('prices and conflicting times never become performance times', () => {
  const r = parse(
    '<li><span>19.50</span><span>Price</span></li>'
    + '<li><span>19:00</span><span>Doors</span></li>'
    + '<li><span>19:30</span><span>Doors</span></li>'
  );
  assert.equal(r.values.doors, undefined);
  assert.equal(r.values.main, undefined);
  assert.equal(r.values.start, undefined);
});

test('Patronaat bullet timetable reads named acts and expected end', () => {
  const concert = { ...c, artist: 'Oh Hiroshima', date: '2026-10-24',
    venue: 'Patronaat', supportingArtists: ['Barrens'] };
  const source = 'https://patronaat.nl/event/oh-hirshima-barrens-24-10-26/';
  for (const bullet of ['•', '·', '&bull;', '&#8226;']) {
    const html = `<main><h1>Oh Hiroshima + Barrens</h1>
      <time datetime="2026-10-24">24 okt 2026</time>
      <p>Deuren: 19:30</p><p>Start: 20:00</p>
      <p><strong>Tijdschema (onder voorbehoud)</strong><br>
        <span>Deuren open ${bullet} 19:30</span><br>
        <span>20:00 ${bullet} <strong>Barrens</strong></span><br>
        <span>21:00 ${bullet} <strong>Oh Hiroshima</strong></span><br>
        <span>Verwacht einde ${bullet} 22:00</span></p></main>`;
    const parsed = parseSchedule(html, concert, source, 'official', stamp);
    const schedule = mergeSchedule(concert, [parsed], stamp, 'manual');
    assert.equal(schedule.doors.time, '19:30');
    assert.equal(schedule.support[0].time, '20:00');
    assert.equal(schedule.main.time, '21:00');
    assert.equal(schedule.main.derivedFrom, undefined);
    assert.equal(schedule.end.time, '22:00');
    assert.equal(schedule.end.status, 'expected');
    assert.equal(schedule.main.sourceUrl, source);
  }
});

test('bullet separators still reject prose, prices and conflicting times', () => {
  const r = parse('<p>Tickets • 19.50</p><p>Example Band tickets • 21:00</p>'
    + '<p>Biography: 21:00 • Example Band</p>'
    + '<p>21:00 • Example Band</p><p>21:30 • Example Band</p>');
  assert.equal(r.values.main, undefined);
  assert.equal(r.values.end, undefined);
  assert.ok(r.conflicts.includes('main'));
});
