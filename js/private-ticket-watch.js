const paths = {
  preferences: 'data/ticket-watches.json',
  state: 'data/ticket-watch-state.json'
};

export function createPrivateWatchStore({ repository, token, fetcher = fetch } = {}) {
  const name = typeof repository === 'string' ? repository.trim() : '';
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(name) || !token) {
    throw new Error('Connect a private Watch repository in Settings.');
  }
  if (name.split('/').some(part => ['.', '..'].includes(part))) throw new Error('Invalid Watch repository.');
  const base = 'https://api.github.com/repos/' + name;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  async function request(path = '', init = {}) {
    const response = await fetcher(base + path, {
      ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout?.(10000),
      headers: init.body ? { ...headers, 'Content-Type': 'application/json' } : headers
    });
    if (!response.ok) {
      const error = new Error('Private Watch repository request failed.');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function verify() {
    const repo = await request();
    if (repo?.private !== true || repo.visibility !== 'private' || repo.full_name?.toLowerCase() !== name.toLowerCase()) {
      throw new Error('Watch storage requires a private GitHub repository.');
    }
  }

  function path(kind) {
    if (!Object.hasOwn(paths, kind)) throw new Error('Invalid Watch document.');
    return '/contents/' + paths[kind];
  }

  return {
    verify,
    async read(kind) {
      await verify();
      try {
        const value = await request(path(kind));
        if (typeof value.sha !== 'string' || !value.sha || typeof value.content !== 'string') {
          throw new Error('Invalid Watch document.');
        }
        const bytes = Uint8Array.from(atob(value.content.replace(/\s/g, '')), character => character.charCodeAt(0));
        const json = JSON.parse(new TextDecoder().decode(bytes));
        if (json?.version !== 1 || !json.entries || typeof json.entries !== 'object' || Array.isArray(json.entries)) {
          throw new Error('Invalid Watch document.');
        }
        return { json, sha: value.sha };
      } catch (error) {
        if (error.status === 404) return { json: { version: 1, entries: {} } };
        throw error;
      }
    },
    async write(kind, json, sha) {
      await verify();
      const bytes = new TextEncoder().encode(JSON.stringify(json, null, 2) + '\n');
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      return request(path(kind), {
        method: 'PUT',
        body: JSON.stringify({ message: 'Update private ticket watch', content: btoa(binary), ...(sha ? { sha } : {}) })
      });
    }
  };
}
