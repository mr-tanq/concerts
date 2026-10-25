import test from 'node:test';
import assert from 'node:assert/strict';
import { removeArchiveRecord } from '../js/archive-remove.js';

test('removes only the selected ID, preserving other dates and metadata', () => {
  const archive = { meta: { recoveredFrom: 'seed', totalConcerts: 3 }, concerts: [
    { id: 'wrong', artist: 'Oh Hiroshima', date: '2026-10-24', notes: 'wrong entry' },
    { id: 'earlier', artist: 'Oh Hiroshima', date: '2024-03-01' },
    { id: 'other', artist: 'Another band', date: '2026-10-24' },
  ] };
  removeArchiveRecord(archive, 'wrong', 'now');
  assert.deepEqual(archive.concerts.map(c => c.id), ['earlier', 'other']);
  assert.deepEqual(archive.meta, {
    recoveredFrom: 'seed', totalConcerts: 2, lastUpdated: 'now'
  });
});
test('refuses missing or ambiguous IDs without mutating the archive', () => {
  for (const id of ['', 'missing', 'duplicate']) {
    const archive = { concerts: [{id:'duplicate'}, {id:'duplicate'}] };
    const before = structuredClone(archive);
    assert.throws(() => removeArchiveRecord(archive, id));
    assert.deepEqual(archive, before);
  }
});
test('can remove the last entry and initialize metadata', () => {
  const archive = { concerts: [{id:'last'}] };
  removeArchiveRecord(archive, 'last', 'now');
  assert.deepEqual(archive, {
    concerts:[], meta:{totalConcerts:0,lastUpdated:'now'}
  });
});
