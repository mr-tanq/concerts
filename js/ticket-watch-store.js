import { createPrivateWatchStore } from './private-ticket-watch.js';
import { isConflictError } from './github-api.js';

const setting = 'lm_private_ticket_watch';
export const WATCH_CHANGED = 'ticket-watch-changed';

export function readWatchConnection() {
  try { return JSON.parse(localStorage.getItem(setting)); } catch { return null; }
}

export async function saveWatchConnection(connection) {
  await createPrivateWatchStore(connection).verify();
  localStorage.setItem(setting, JSON.stringify(connection));
  window.dispatchEvent(new Event(WATCH_CHANGED));
}

export function clearWatchConnection() {
  localStorage.removeItem(setting);
  window.dispatchEvent(new Event(WATCH_CHANGED));
}

// The Watchlist uses this only for public market and official offer snapshots.
export async function readWatchData(path) {
  if (!['data/ticketswap.json', 'data/official-ticket-offers.json'].includes(path)) {
    throw new Error('Watch documents require private storage.');
  }
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout?.(5000) });
  if (!response.ok) throw new Error('Watch data unavailable');
  const value = await response.json();
  if (value?.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    throw new Error('Watch data unavailable');
  }
  return value;
}

async function readPrivate(kind) {
  const store = createPrivateWatchStore(readWatchConnection() ?? {});
  return (await store.read(kind)).json;
}

export const readWatches = () => readPrivate('preferences');
export const readWatchState = () => readPrivate('state');

export async function changeWatch(concertId, change) {
  const store = createPrivateWatchStore(readWatchConnection() ?? {});
  for (let attempt = 0; attempt < 3; attempt++) {
    const { json, sha } = await store.read('preferences');
    const entry = Object.hasOwn(json.entries, concertId) ? json.entries[concertId] : null;
    const next = change(entry);
    const entries = { ...json.entries };
    if (next) Object.defineProperty(entries, concertId, { value: next, enumerable: true, configurable: true, writable: true });
    else delete entries[concertId];
    try {
      await store.write('preferences', { ...json, entries }, sha);
      window.dispatchEvent(new Event(WATCH_CHANGED));
      return next;
    } catch (error) {
      if (!isConflictError(error) || attempt === 2) throw error;
    }
  }
}
