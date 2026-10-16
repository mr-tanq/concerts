import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { commitJSONFiles } from '../js/github-transaction.js';

const R = 'data/recommendations.json';
const P = 'data/planned.json';
const error = status =>
  Object.assign(new Error('Simulated GitHub failure'), { status });

const initial = () => ({
  [R]: { concerts: [{ id: 'rec-1', artist: 'Μπάντα' }] },
  [P]: { concerts: [] },
  'untouched.txt': 'Keep this file'
});

function server({ fail, conflict, branch = 'main' } = {}) {
  const commits = new Map([
    ['head-0', { files: initial(), tree: { sha: 'base-0' } }]
  ]);
  const trees = new Map([['base-0', initial()]]);
  let head = 'head-0', n = 0, publications = 0, conflicted = false;

  const request = async (endpoint, options = {}) => {
    const method = options.method || 'GET';
    if (fail === endpoint) throw error(403);
    if (!endpoint) return { default_branch: branch };

    if (endpoint === 'git/ref/heads/' + branch) {
      return { object: { sha: head } };
    }

    if (method === 'GET' && endpoint.startsWith('git/commits/')) {
      const commit = commits.get(endpoint.slice('git/commits/'.length));
      assert.ok(commit);
      return { tree: commit.tree };
    }

    if (endpoint.startsWith('contents/')) {
      const u = new URL('https://example.test/' + endpoint);
      const ref = u.searchParams.get('ref');
      assert.ok(commits.has(ref), 'Reads must use a fixed commit');
      const value = commits.get(ref).files[
        u.pathname.slice('/contents/'.length)
      ];
      return {
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(value)).toString('base64')
      };
    }

    const body = JSON.parse(options.body);

    if (endpoint === 'git/trees') {
      assert.equal(method, 'POST');
      const files = structuredClone(trees.get(body.base_tree));
      assert.ok(files, 'Base tree must retain unrelated files');
      for (const entry of body.tree) {
        assert.equal(entry.mode, '100644');
        files[entry.path] = JSON.parse(entry.content);
      }
      const sha = 'tree-' + ++n;
      trees.set(sha, files);
      return { sha };
    }

    if (endpoint === 'git/commits') {
      assert.equal(body.parents.length, 1);
      const sha = 'commit-' + ++n;
      commits.set(sha, {
        files: trees.get(body.tree),
        tree: { sha: body.tree },
        parent: body.parents[0]
      });
      return { sha };
    }

    if (endpoint === 'git/refs/heads/' + branch) {
      assert.equal(method, 'PATCH');
      assert.equal(body.force, false);

      if (conflict && !conflicted) {
        conflicted = true;
        const files = structuredClone(commits.get(head).files);
        files[P].otherUserEdit = 'preserve me';
        files[R].concerts.push({ id: 'rec-other' });
        trees.set('concurrent-tree', files);
        commits.set('concurrent-head', {
          files, tree: { sha: 'concurrent-tree' }
        });
        head = 'concurrent-head';
        throw error(conflict);
      }

      if (commits.get(body.sha).parent !== head) throw error(409);
      head = body.sha;
      publications++;
      return { object: { sha: head } };
    }

    throw new Error('Unexpected request ' + endpoint);
  };

  return {
    request,
    visible: () => commits.get(head).files,
    publications: () => publications
  };
}

function move(files) {
  const rec = files[R].concerts.find(x => x.id === 'rec-1');
  files[R].concerts = files[R].concerts.filter(x => x.id !== 'rec-1');
  if (rec && !files[P].concerts.some(x => x.id === rec.id)) {
    files[P].concerts.push(rec);
  }
}

test('related files publish together and preserve other files', async () => {
  const s = server();
  await commitJSONFiles(s.request, [R, P], move, 'Plan');
  assert.equal(s.visible()[R].concerts.length, 0);
  assert.equal(s.visible()[P].concerts[0].artist, 'Μπάντα');
  assert.equal(s.visible()['untouched.txt'], 'Keep this file');
  assert.equal(s.publications(), 1);
});

for (const endpoint of [
  'git/trees', 'git/commits', 'git/refs/heads/main'
]) {
  test('failure at ' + endpoint + ' preserves both files', async () => {
    const s = server({ fail: endpoint });
    await assert.rejects(
      commitJSONFiles(s.request, [R, P], move, 'Plan')
    );
    assert.deepEqual(s.visible(), initial());
    assert.equal(s.publications(), 0);
  });
}

for (const status of [409, 422]) {
  test('conflict ' + status + ' preserves concurrent changes', async () => {
    const s = server({ conflict: status });
    await commitJSONFiles(s.request, [R, P], move, 'Plan');
    assert.equal(s.visible()[P].otherUserEdit, 'preserve me');
    assert.equal(s.visible()[R].concerts[0].id, 'rec-other');
    assert.equal(s.visible()[P].concerts.length, 1);
    assert.equal(s.publications(), 1);
  });
}

test('repeated operation creates no duplicate', async () => {
  const s = server();
  await commitJSONFiles(s.request, [R, P], move, 'Plan');
  await commitJSONFiles(s.request, [R, P], move, 'Plan');
  assert.equal(s.publications(), 1);
  assert.equal(s.visible()[P].concerts.length, 1);
});

test('invalid paths and failed mutations never publish', async () => {
  const s = server();
  await assert.rejects(
    commitJSONFiles(s.request, ['index.html'], move, 'Bad')
  );
  await assert.rejects(commitJSONFiles(s.request, [R, P], () => {
    throw error(500);
  }, 'Bad'));
  assert.equal(s.publications(), 0);
});

test('app uses the shared transaction for mutations', async () => {
  const app = await readFile(
    new URL('../js/app.js', import.meta.url), 'utf8'
  );
  const source = app.match(
    /^async function mutate\([\s\S]*?^}/m
  )?.[0];
  assert.ok(source);

  const s = server();
  const context = vm.createContext({
    getGithubConfig: () => ({}),
    mutateJSONFiles: (_config, ...args) =>
      commitJSONFiles(s.request, ...args)
  });
  vm.runInContext(source, context);
  await context.mutate([R, P], move, 'Plan');

  assert.equal(s.visible()[P].concerts.length, 1);
  assert.equal(s.publications(), 1);
});
