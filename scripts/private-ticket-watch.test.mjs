import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateWatchStore } from '../js/private-ticket-watch.js';
import { readWatchData } from '../js/ticket-watch-store.js';
const repository = 'owner/private-watch';
const config = { repository, token: 'offline-fixture-secret' };
const metadata = { full_name: repository, private: true, visibility: 'private' };

test('public or redirected/replaced repositories cannot receive private reads or writes', async () => {
  for (const identity of [
    { ...metadata, private: false, visibility: 'public' },
    { ...metadata, visibility: 'internal' },
    { ...metadata, full_name: 'other/private-watch' }
  ]) {
    const calls = [];
    const store = createPrivateWatchStore({ ...config, fetcher: async url => {
      calls.push(url); return Response.json(identity);
    } });
    await assert.rejects(store.read('state'), /private GitHub/);
    await assert.rejects(store.write('preferences', { version: 1, entries: {} }), /private GitHub/);
    assert.deepEqual(calls, [`https://api.github.com/repos/${repository}`, `https://api.github.com/repos/${repository}`]);
  }
  await assert.rejects(readWatchData('data/ticket-watch-state.json'), /private storage/);
  assert.throws(() => createPrivateWatchStore({ ...config, repository: 'owner/..' }), /Invalid/);
});

test('verified private store can initialize documents and keeps Unicode with protected SHA on edits', async () => {
  const data = { version: 1, entries: { example: { artist: 'Queensrÿche' } } };
  let saved = false;
  let puts = 0;
  const store = createPrivateWatchStore({ ...config, fetcher: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    if (url.endsWith(repository)) return Response.json(metadata);
    assert.ok(url.endsWith('/data/ticket-watches.json'));
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, puts ? 'prior-sha' : undefined);
      assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), data);
      puts++;
      saved = true;
      return Response.json({});
    }
    return saved ? Response.json({ sha: 'prior-sha', content: Buffer.from(JSON.stringify(data)).toString('base64') })
      : new Response(null, { status: 404 });
  } });
  assert.deepEqual((await store.read('preferences')).json, { version: 1, entries: {} });
  await store.write('preferences', data);
  const current = await store.read('preferences');
  assert.deepEqual(current.json, data);
  await store.write('preferences', current.json, current.sha);
  assert.equal(puts, 2);
});
