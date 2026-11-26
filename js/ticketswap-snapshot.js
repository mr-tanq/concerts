export function createSnapshotCache(read, { now = Date.now, ttl = 60000 } = {}) {
  let saved;
  let expiresAt = 0;
  let pending;
  let retryAt = 0;

  function publish(data) {
    if (data?.version !== 1 || !data.entries
      || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
      throw new Error('Invalid snapshot');
    }

    // A GitHub API result can arrive before Pages serves the same revision.
    if (saved && Date.parse(saved.updatedAt) > (Date.parse(data.updatedAt) || 0)) {
      return false;
    }
    saved = data;
    expiresAt = now() + ttl;
    retryAt = 0;
    return true;
  }

  async function load() {
    if (saved && now() < expiresAt) return { data: saved, stale: false };
    if (saved && now() < retryAt) return { data: saved, stale: true };
    pending ??= Promise.resolve().then(read)
      .then(data => {
        if (publish(data)) return { data, stale: false };
        return { data: saved, stale: now() >= expiresAt };
      })
      .catch(error => {
        if (!saved) throw error;
        retryAt = now() + Math.min(ttl, 10000);
        return { data: saved, stale: now() >= expiresAt };
      })
      .finally(() => { pending = null; });
    return pending;
  }

  return { load, publish };
}
