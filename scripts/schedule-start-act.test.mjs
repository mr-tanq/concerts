import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, mergeSchedule } from './enrich-concert-schedules.mjs';
import { scheduleMarkup, scheduleCountdown } from '../js/concert-schedule.js';

const base = {
  artist: 'Example Band', date: '2026-11-03',
  venue: '013', country: 'NL', supportingArtists: []
};
const url = 'https://www.013.nl/programma/example';
const stamp = '2026-10-16T09:00:00Z';

const result = (c, extra = '') => parseSchedule(
  `<main><h1>Example Band</h1>
   <time datetime="2026-11-03">3 nov 2026</time>
   <p>Doors 19:00</p><p>Start 20:00</p>${extra}</main>`,
  c, url, 'official', stamp
);

test('programme start goes to the sole support with source evidence', () => {
  const c = { ...base, supportingArtists: ['Guest Act'] };
  const s = mergeSchedule(c, [result(c)], stamp, 'manual');
  assert.equal(s.support[0].time, '20:00');
  assert.equal(s.main.time, null);
  assert.equal(s.support[0].sourceUrl, url);
  assert.ok(!scheduleMarkup({ ...c, schedule: s }).includes('PROGRAMME START'));
  assert.equal(
    scheduleCountdown({ ...c, schedule: s }, Date.parse('2026-11-03T18:30Z')),
    'GUEST ACT IN 30M'
  );
});

test('without support programme start goes to the main act', () => {
  const s = mergeSchedule(base, [result(base)], stamp, 'manual');
  assert.equal(s.main.time, '20:00');
  assert.equal(s.main.derivedFrom, 'programme-start');
});

test('explicit artist times always take precedence', () => {
  const c = { ...base, supportingArtists: ['Guest Act'] };
  const s = mergeSchedule(c, [
    result(c, '<p>Guest Act 20:15</p><p>Example Band 21:15</p>')
  ], stamp, 'manual');
  assert.equal(s.support[0].time, '20:15');
  assert.equal(s.main.time, '21:15');
});

test('multiple supports retain a group start without guessing order', () => {
  const c = { ...base, supportingArtists: ['Guest One', 'Guest Two'] };
  const s = mergeSchedule(c, [result(c)], stamp, 'manual');
  assert.ok(s.support.every(f => f.time === null));
  assert.ok(!scheduleMarkup({ ...c, schedule: s }).includes('data-schedule-kind="start"'));
});

test('changed lineups recalculate derived times', () => {
  const s = mergeSchedule(base, [result(base)], stamp, 'manual');
  const c = { ...base, schedule: s, supportingArtists: ['Guest Act'] };
  const changed = mergeSchedule(c, [], '2026-10-16T10:00:00Z', 'manual');
  assert.equal(changed.main.time, null);
  assert.equal(changed.support[0].time, '20:00');
});
