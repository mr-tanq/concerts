import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { staleResultFiles, pruneOldResults } from './search-concerts.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');

test('only results older than the keep window are stale', () => {
  const stale = staleResultFiles([
    { name: 'old.json', checkedAt: '2026-11-10T12:00:00Z' },
    { name: 'recent.json', checkedAt: '2026-11-20T12:00:00Z' },
    { name: 'broken.json', checkedAt: null },
  ], NOW);
  assert.deepEqual(stale, ['old.json', 'broken.json']);
});

test('pruning deletes stale files through the API and never the current one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'results-'));
  await writeFile(path.join(dir, 'old.json'), JSON.stringify({ checkedAt: '2026-10-01T00:00:00Z' }));
  await writeFile(path.join(dir, 'current.json'), JSON.stringify({ checkedAt: '2026-10-01T00:00:00Z' }));
  await writeFile(path.join(dir, 'fresh.json'), JSON.stringify({ checkedAt: '2026-11-23T00:00:00Z' }));
  const calls = [];
  const fetcher = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', url.split('/').pop()]);
    if (!opts.method) return { ok: true, json: async () => [{ name: 'old.json', sha: 'a' }, { name: 'current.json', sha: 'b' }, { name: 'fresh.json', sha: 'c' }] };
    assert.equal(JSON.parse(opts.body).sha, 'a');
    return { ok: true };
  };
  const removed = await pruneOldResults('o/r', 't', { keep: 'current', now: NOW, fetcher, dir });
  assert.deepEqual(removed, ['old.json']);
  assert.deepEqual(calls, [['GET', 'concert-search-results'], ['DELETE', 'old.json']]);
});
