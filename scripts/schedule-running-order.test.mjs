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
const rows = ['Deuren open • 18:30', '19:00 • <strong>Peace of Mind</strong>', '19:50 • <strong>Magnitude</strong>',
  '20:40 • <strong>Bane</strong>', '21:40 • <strong>Terror</strong>', 'Verwacht einde • 22:40'];
const intro = '<p>Van old school tot de nieuwe generatie: vier bands die hardcore spelen zoals het bedoeld is.</p>';
const wrap = body => `<main><h1>Terror + Bane + Start Today + Peace Of Mind</h1><time datetime="${c.date}"></time>
<div class="event__content">${intro}${body}</div></main>`;
// Venues write the same running order in several ways; all must read the same.
const layouts = {
  'one <p> with <br>': wrap(`<p><strong>Tijdschema (onder voorbehoud)</strong><br>${rows.join('<br>\n')}</p>`),
  'a <p> per line': wrap(`<h3>Tijdschema (onder voorbehoud)</h3>${rows.map(r => `<p>${r}</p>`).join('\n')}`),
  'a list': wrap(`<p><strong>Tijdschema</strong></p><ul>${rows.map(r => `<li>${r}</li>`).join('')}</ul>`),
  // Verbatim from patronaat.nl (Nov 2026): <br> with attributes, a <span> per line.
  'Patronaat as published': wrap(`<p><span style="color: #231f20;"><strong style="color: #000000;">Tijdschema (onder voorbehoud)</strong></span> <br style="color: #231f20;" /><span style="color: #231f20;">Deuren open • 18:30</span><br style="color: #231f20;" /><span style="color: #231f20;">19:00 • <strong>Peace of Mind</strong></span><br style="color: #231f20;" /><span style="color: #231f20;">19:50 • <strong>Magnitude</strong></span><br style="color: #231f20;" /><span style="color: #231f20;">20:40 • <strong>Bane</strong></span><br style="color: #231f20;" /><span style="color: #231f20;">21:40 • <strong>Terror</strong></span><br style="color: #231f20;" /><span style="color: #231f20;">Verwacht einde • 22:40</span></p>`),
  'divs with nbsp': wrap(`<div>Tijdschema</div>${rows.map(r => `<div>${r.replace(' • ', '&nbsp;•&nbsp;')}</div>`).join('')}`),
};
const page = layouts['one <p> with <br>'];

for (const [name, html] of Object.entries(layouts)) {
  test(`running order is read from ${name}`, () => {
    const s = mergeSchedule(c, [parseSchedule(html, c, url, 'official', now)], now, 'manual');
    assert.deepEqual(s.support.map(a => [a.name, a.time]),
      [['Peace of Mind', '19:00'], ['Magnitude', '19:50'], ['Bane', '20:40']]);
    assert.equal(s.main.time, '21:40');
    assert.equal(s.fullTimetable, true);
  });
}

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
