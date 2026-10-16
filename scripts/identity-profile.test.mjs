import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, copyFile, writeFile, readFile, rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readIdentityProfile } from './lib/identity-profile.mjs';

const previous = {
  meta: { lastfmUser: 'errz', lastUpdated: 'old' },
  profile: { totalScrobbles: 1234 },
  marker: 'keep this snapshot'
};
const info = value => ({
  user: {
    name: 'errz', playcount: value,
    registered: { unixtime: '1227900308' }
  }
});

test('valid totals, including corrections, are accepted', () => {
  for (const value of ['1235', 1235, 1200]) {
    assert.equal(
      readIdentityProfile(info(value), 'errz', previous).totalScrobbles,
      Number(value)
    );
  }
});

test('missing and invalid counts never become zero', () => {
  for (const value of [
    undefined, null, '', ' ', 'invalid', -1, 1.5,
    true, [], {}, Infinity, '1e3'
  ]) {
    assert.throws(() => readIdentityProfile(info(value), 'errz', previous));
  }
});

test('zero cannot replace a previous positive total', () => {
  assert.throws(() => readIdentityProfile(info('0'), 'errz', previous));
  assert.equal(readIdentityProfile(info('0'), 'errz').totalScrobbles, 0);
});

test('wrong accounts and missing profiles are rejected', () => {
  assert.throws(() => readIdentityProfile({}, 'errz', previous));
  assert.throws(() => readIdentityProfile(info('1235'), 'another-user', previous));
  assert.equal(
    readIdentityProfile(info('1235'), 'ERRZ', previous).totalScrobbles,
    1235
  );
});

test('invalid registration dates are rejected', () => {
  const data = info('1235');
  data.user.registered = {};
  assert.throws(() => readIdentityProfile(data, 'errz', previous));
});

for (const [title, playcount, succeeds] of [
  ['invalid refresh preserves the entire file', '0', false],
  ['valid refresh publishes complete JSON', '1235', true]
]) test(title, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'identity-guard-'));
  try {
    await mkdir(path.join(dir, 'scripts/lib'), { recursive: true });
    await mkdir(path.join(dir, 'data'));

    for (const file of ['fetch-identity.mjs', 'lib/identity-profile.mjs']) {
      await copyFile(
        new URL(file, import.meta.url),
        path.join(dir, 'scripts', file)
      );
    }

    const target = path.join(dir, 'data/identity.json');
    const before = JSON.stringify(previous);
    await writeFile(target, before);

    const mock = `
      const nativeTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) =>
        nativeTimeout(fn, ms >= 10000 ? ms : 0, ...args);
      globalThis.fetch = async url => {
        const method = new URL(url).searchParams.get('method');
        const json = method === 'user.getinfo'
          ? ${JSON.stringify(info(playcount))}
          : method === 'user.gettopartists'
          ? { topartists: { artist: [],
              '@attr': { total: '0', totalPages: '0' } } }
          : method === 'user.gettoptracks'
          ? { toptracks: { track: [] } }
          : method === 'user.gettopalbums'
          ? { topalbums: { album: [] } }
          : { recenttracks: { track: [],
              '@attr': { totalPages: '0' } } };
        return { ok: true, json: async () => json };
      };`;

    const proc = spawnSync(process.execPath, [
      '--import', 'data:text/javascript,' + encodeURIComponent(mock),
      path.join(dir, 'scripts/fetch-identity.mjs')
    ], {
      encoding: 'utf8', timeout: 15000,
      env: { LASTFM_USER: 'errz', LASTFM_API_KEY: 'test-key' }
    });

    assert.ifError(proc.error);
    const after = await readFile(target, 'utf8');

    if (succeeds) {
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(JSON.parse(after).profile.totalScrobbles, 1235);
    } else {
      assert.notEqual(proc.status, 0);
      assert.equal(after, before);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
