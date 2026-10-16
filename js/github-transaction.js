// Publish related JSON changes together; never use partial per-file writes.
export async function commitJSONFiles(request, paths, apply, message, attempts = 4) {
  paths = [...new Set(paths)];
  if (!paths.length || paths.some(p => !/^data\/[a-z0-9-]+\.json$/i.test(p))) {
    throw new Error('Invalid data paths');
  }

  const repo = await request('');
  if (!repo.default_branch) throw new Error('Missing repository branch');
  const ref = 'heads/' + repo.default_branch.split('/').map(encodeURIComponent).join('/');

  for (let attempt = 0; attempt < attempts; attempt++) {
    const head = (await request('git/ref/' + ref)).object?.sha;
    if (!head) throw new Error('Missing branch head');

    const base = await request('git/commits/' + head);
    if (!base.tree?.sha) throw new Error('Missing base tree');

    const files = Object.create(null);
    const before = Object.create(null);

    await Promise.all(paths.map(async p => {
      const file = await request(
        'contents/' + p + '?ref=' + encodeURIComponent(head)
      );
      if (file.encoding !== 'base64' || typeof file.content !== 'string') {
        throw new Error('Could not read ' + p);
      }

      const bytes = Uint8Array.from(
        atob(file.content.replace(/\s/g, '')),
        c => c.charCodeAt(0)
      );
      files[p] = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      );
      before[p] = JSON.stringify(files[p]);
    }));

    const touched = apply(files) || paths;
    if (!Array.isArray(touched) || touched.some(p => !paths.includes(p))) {
      throw new Error('Invalid transaction result');
    }

    const tree = [...new Set(touched)]
      .filter(p => JSON.stringify(files[p]) !== before[p])
      .map(p => ({
        path: p,
        mode: '100644',
        type: 'blob',
        content: JSON.stringify(files[p], null, 2) + '\n'
      }));

    if (!tree.length) return files;

    const createdTree = await request('git/trees', {
      method: 'POST',
      body: JSON.stringify({ base_tree: base.tree.sha, tree })
    });
    if (!createdTree.sha) throw new Error('Missing prepared tree');

    const commit = await request('git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message,
        tree: createdTree.sha,
        parents: [head]
      })
    });
    if (!commit.sha) throw new Error('Missing prepared commit');

    try {
      await request('git/refs/' + ref, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false })
      });
      return files;
    } catch (error) {
      if (![409, 422].includes(error.status) || attempt === attempts - 1) {
        throw error;
      }
      // Re-read all files and reapply against the latest commit.
    }
  }

  throw new Error('Could not save the transaction');
}

export async function mutateJSONFiles(config, paths, apply, message, attempts = 4) {
  if (!config?.token) throw new Error('Not connected to GitHub');

  const base = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;

  const request = async (endpoint, options = {}) => {
    const res = await fetch(base + (endpoint ? '/' + endpoint : ''), {
      ...options,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!res.ok) {
      const error = new Error(
        `Could not save concert changes (GitHub ${res.status}).`
      );
      error.status = res.status;
      throw error;
    }

    return res.json();
  };

  return commitJSONFiles(request, paths, apply, message, attempts);
}
