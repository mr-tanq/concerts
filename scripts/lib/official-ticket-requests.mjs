import { localDate } from '../../js/concert-schedule.js';
import { identity } from '../../js/ticketswap-matching.js';
import { refreshOfficialTickets } from './official-ticket-refresh.mjs';

const requestAgeLimit = 10 * 60000;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function processOfficialTicketRequests({
  queue, store, concerts, resale, mappings, readPage, resolveSeller = null, clock = Date.now
}) {
  if (queue?.version !== 1 || !queue.requests || typeof queue.requests !== 'object'
    || Array.isArray(queue.requests)) throw new Error('Invalid official ticket request queue');
  const now = clock();
  const requests = Object.entries(queue.requests).filter(([id, request]) => {
    const age = now - Date.parse(request?.requestedAt);
    return requestIdPattern.test(request?.requestId) && typeof request?.identity === 'string'
      && request.identity.length <= 2000 && age >= 0 && age < requestAgeLimit
      && store.entries[id]?.lastCheck?.requestId !== request.requestId;
  }).sort(([, a], [, b]) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt)).slice(0, 3);

  const planned = new Map(concerts.map(concert => [concert.id, concert]));
  for (const [id, request] of requests) {
    const concert = planned.get(id);
    const attemptedAt = clock();
    let status = 'invalid';
    if (concert && identity(concert) === request.identity
      && (concert.endDate || concert.date) >= localDate(attemptedAt, 'Europe/Amsterdam')) {
      try {
        const checked = await refreshOfficialTickets({
          store, concert, resale: resale[id], mappings, readPage, resolveSeller, now: attemptedAt
        });
        store = checked.store;
        status = checked.status;
        if (status === 'cached') {
          const checks = Object.values(store.entries[id]?.providerChecks ?? {});
          if (!checks.some(check => check.status === 'verified')) {
            status = checks.some(check => check.status === 'failed') ? 'unavailable' : 'unsupported';
          }
        }
      } catch {
        status = 'error';
      }
    }
    const current = Object.hasOwn(store.entries, id) ? store.entries[id] : null;
    store = {
      ...store,
      updatedAt: new Date(Math.max(clock(), Date.parse(store.updatedAt) || 0)).toISOString(),
      entries: {
        ...store.entries,
        [id]: {
          ...(current ?? { identity: request.identity, offers: [] }),
          lastCheck: { identity: request.identity, requestId: request.requestId, lastAttemptAt: new Date(attemptedAt).toISOString(), status }
        }
      }
    };
  }
  return store;
}
