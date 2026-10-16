import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulePhase } from './enrich-concert-schedules.mjs';

const now = Date.parse('2026-10-16T08:00:00Z');
const concert = {
  id: 'later', artist: 'Example Band', date: '2027-02-18',
  venue: 'Example Venue', city: 'Utrecht', country: 'NL'
};

const requested = (minutes = 1) => ({
  ...concert,
  schedule: {
    date: concert.date,
    refreshRequestedAt: new Date(now - minutes * 60000).toISOString()
  }
});

test('manual refresh works at any future distance', () => {
  for (const days of [8, 32, 125, 365]) {
    const date = new Date(now + days * 86400000).toISOString().slice(0, 10);
    const c = requested();
    c.date = date;
    c.schedule.date = date;
    assert.equal(schedulePhase(c, 'next', now), 'manual');
  }
});

test('automatic checks retain the one-week window and NEXT exception', () => {
  assert.equal(schedulePhase(concert, 'next', now), null);
  assert.equal(schedulePhase(concert, concert.id, now), 'initial');
  assert.equal(schedulePhase({
    ...concert, date: '2026-10-20'
  }, 'next', now), 'initial');
});

test('completed requests and cooldown remain respected', () => {
  const completed = requested();
  completed.schedule.lastAttemptAt = new Date(now - 30000).toISOString();
  assert.equal(schedulePhase(completed, 'next', now), null);

  const cooldown = requested();
  cooldown.schedule.lastAttemptAt =
    new Date(now - 2 * 60000).toISOString();

  assert.equal(schedulePhase(cooldown, 'next', now), null);
  assert.equal(
    schedulePhase(cooldown, 'next', now + 5 * 60000),
    'manual'
  );
});

test('past concerts, invalid dates and expired requests are skipped', () => {
  assert.equal(schedulePhase({
    ...requested(), date: '2026-10-15'
  }, 'next', now), null);

  assert.equal(schedulePhase({
    ...requested(), date: 'invalid'
  }, 'next', now), null);

  assert.equal(schedulePhase(requested(25 * 60), 'next', now), null);
});
