import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, mergeSchedule } from './sources/concert-schedule.mjs';
import { scheduleMarkup } from '../js/concert-schedule.js';

const now = '2026-11-25T01:00:00Z';
// Podiuminfo still billed Start Today; the venue replaced them with Magnitude.
const c = {
  id: 'terror-patronaat', artist: 'Terror', date: '2026-12-02', venue: 'Patronaat', city: 'Haarlem', country: 'NL',
  supportingArtists: ['Bane', 'Start Today', 'Peace of Mind'],
};
const url = 'https://patronaat.nl/event/terror-02-12-26/';
const page = `<main><h1>Terror + Bane + Start Today + Peace Of Mind</h1><time datetime="${c.date}"></time>
<p><strong>Tijdschema (onder voorbehoud)</strong><br>Deuren open • 18:30<br>19:00 • <strong>Peace of Mind</strong><br>
19:50 • <strong>Magnitude</strong><br>20:40 • <strong>Bane</strong><br>21:40 • <strong>Terror</strong><br>Verwacht einde • 22:40</p></main>`;

test('an official running order adds acts discovery never knew', () => {
  const s = mergeSchedule(c, [parseSchedule(page, c, url, 'official', now)], now, 'manual');
  assert.equal(s.main.time, '21:40');
  assert.equal(s.doors.time, '18:30');
  assert.equal(s.end.time, '22:40');
  assert.deepEqual(s.support.map(a => [a.name, a.time]),
    [['Peace of Mind', '19:00'], ['Magnitude', '19:50'], ['Bane', '20:40']]);
  assert.equal(s.fullTimetable, true);
});

test('acts missing from the official running order are not shown as TBA', () => {
  const s = mergeSchedule(c, [parseSchedule(page, c, url, 'official', now)], now, 'manual');
  assert.ok(!s.support.some(a => a.name === 'Start Today'));
  const html = scheduleMarkup({ ...c, schedule: s });
  assert.doesNotMatch(html, /Start Today/);
  assert.match(html, /Magnitude/);
});

test('two time-led lines are not enough to call it a running order', () => {
  const short = `<main><h1>Terror</h1><time datetime="${c.date}"></time><p>19:00 • Peace of Mind<br>21:40 • Terror</p></main>`;
  const r = parseSchedule(short, c, url, 'official', now);
  assert.equal(r.fullTimetable, false);
});
