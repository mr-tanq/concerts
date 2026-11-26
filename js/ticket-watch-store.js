import { getFile, getGithubConfig, isConflictError, putFile } from './github-api.js';

const path = 'data/ticket-watches.json';
let pending;
export const WATCH_CHANGED = 'ticket-watch-changed';

export async function readWatchData(path) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout?.(5000) });
  if (!response.ok) throw new Error('Watch data unavailable');
  return validate(await response.json());
}

function validate(value) {
  if (value?.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    throw new Error('Watch data unavailable');
  }
  return value;
}

export function readWatches() {
  const config = getGithubConfig();
  if (!config?.token) return readWatchData(path);
  pending ??= getFile(config, path).then(result => validate(result.json)).finally(() => { pending = null; });
  return pending;
}

export async function changeWatch(concertId, change) {
  const config = getGithubConfig();
  if (!config?.token) throw new Error('Connect GitHub in Settings to save a watch.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const { json, sha } = await getFile(config, path);
    validate(json);
    const entry = Object.hasOwn(json.entries, concertId) ? json.entries[concertId] : null;
    const next = change(entry);
    const entries = { ...json.entries };
    if (next) entries[concertId] = next;
    else delete entries[concertId];
    try {
      await putFile(config, path, { ...json, entries }, sha, 'Update ticket watch');
      window.dispatchEvent(new Event(WATCH_CHANGED));
      return next;
    } catch (error) {
      if (!isConflictError(error) || attempt === 2) throw new Error('Could not save the watch in GitHub.');
    }
  }
}
