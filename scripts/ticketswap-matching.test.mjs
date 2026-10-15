import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTicketSwap } from './lib/ticketswap-matching.mjs';

const concert = {
  artist: 'Example Band', date: '2026-11-03',
  venue: '013', city: 'Tilburg', country: 'NL'
};
const event = change => ({
  __typename: 'EventResult', id: 'main', name: 'Example Band',
  startDate: '2026-11-03T20:00:00+01:00',
  locationName: 'Poppodium 013', cityName: 'Tilburg',
  country: { code: 'NL' },
  uri: { url: 'https://www.ticketswap.com/event/example' },
  ...change
});
const result = (items, page = {}) =>
  resolveTicketSwap(concert, items, page).status;

test('venue prefixes, casing and accents', () => {
  for (const name of ['Example Band', 'EXAMPLE BAND', 'Éxample Bánd']) {
    assert.equal(result([event({ name })]), 'matched');
  }
});
test('tour and support titles', () => {
  for (const name of [
    'Example Band - Any Album European Tour',
    'Example Band 30th Anniversary Tour',
    'Example Band + Another Band',
    'Example Band+Another Band'
  ]) assert.equal(result([event({ name })]), 'matched');
});
test('full artist name required', () => {
  assert.equal(result([event({ name: 'Example Bandits Tour' })]), 'not-found');
  assert.equal(result([event({ name: 'Example Band Experiment' })]), 'needs-review');
});
test('non-entry listings excluded', () => {
  for (const suffix of [
    'Upgrade', 'Parking', 'VIP Package', 'Tribute',
    'Afterparty', 'Locker', 'Shuttle'
  ]) {
    assert.equal(
      result([event({ name: 'Example Band ' + suffix })]),
      'not-found'
    );
  }
});
test('date and country remain strict', () => {
  assert.equal(result([event({ startDate: '2026-11-04' })]), 'not-found');
  assert.equal(result([event({ country: { code: 'BE' } })]), 'not-found');
  assert.equal(result([event({ country: null })]), 'needs-review');
});
test('room and city differences require review', () => {
  assert.equal(result([event({ locationName: '013 Main Stage' })]), 'needs-review');
  assert.equal(result([event({ cityName: 'Other city' })]), 'needs-review');
});
test('duplicates versus separate possible events', () => {
  assert.equal(result([event(), event()]), 'matched');
  assert.equal(result([event(), event({ id: 'second' })]), 'needs-review');
});
test('incomplete search is not reported as definitive absence', () => {
  assert.equal(result([], { hasNextPage: true }), 'search-incomplete');
  assert.equal(result([], { hasNextPage: false }), 'not-found');
});
test('unsafe links excluded', () => {
  assert.equal(result([event({
    uri: { url: 'https://ticketswap.com.evil.test' }
  })]), 'not-found');
});

test('shared lineups match regardless of artist order', () => {
  for (const name of [
    'Other Act + Example Band + Third Act',
    'Other Act+Example Band',
    'Other Act & Example Band',
    'Other Act / EXAMPLE BAND',
    'Third Act + Other Act + Éxample Bánd'
  ]) assert.equal(result([event({ name })]), 'matched');

  assert.equal(result([event({
    name: 'Other Act + Example Bandits'
  })]), 'not-found');

  assert.equal(result([event({
    name: 'Other Act + Example Band Experiment'
  })]), 'needs-review');

  assert.equal(result([event({
    name: 'Other Act presents Example Band'
  })]), 'needs-review');

  assert.equal(result([event({
    name: 'Other Act + Example Band VIP Package'
  })]), 'not-found');

  assert.equal(result([event({
    name: 'Other Act + Example Band',
    startDate: '2026-11-04'
  })]), 'not-found');

  assert.equal(result([
    event({ name: 'Other Act + Example Band' }),
    event({ id: 'second', name: 'Third Act + Example Band' })
  ]), 'needs-review');
});

test('extended venue names versus separate rooms', () => {
  const c = { ...concert, venue: 'Examplehouse' };
  const check = locationName =>
    resolveTicketSwap(c, [event({ locationName })]).status;

  assert.equal(check('Examplehouse Culturepark'), 'matched');

  for (const name of [
    'Examplehouse Room 2',
    'Examplehouse Main Stage',
    'Examplehouse Kleine Zaal',
    'Examplehouse Studio',
    'Examplehouse Annex'
  ]) assert.equal(check(name), 'needs-review');

  assert.equal(check('ExamplehouseOther'), 'needs-review');

  assert.equal(resolveTicketSwap(c, [
    event({ locationName: 'Examplehouse Culturepark' }),
    event({ id: 'other', locationName: 'Examplehouse' })
  ]).status, 'needs-review');

  assert.equal(resolveTicketSwap(c, [event({
    locationName: 'Examplehouse Culturepark',
    cityName: 'Elsewhere'
  })]).status, 'needs-review');
});
