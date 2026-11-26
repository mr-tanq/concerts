import { identity } from './ticketswap-matching.js';
import {
  getGithubConfig, getFile, putFile, isConflictError
} from './github-api.js';

const QUEUE = 'data/ticketswap-requests.json';
const RESULTS = 'data/ticketswap.json';
async function readOrEmpty(config, path, empty) {
  try {
    return await getFile(config, path);
  } catch (e) {
    if (e.status === 404) return { json: empty };
    throw e;
  }
}

async function requestCheck(config, concert, { queuePath, resultsPath, getAttempt, label, selectedEventId }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const [queue, result] = await Promise.all([
      readOrEmpty(config, queuePath, { version: 1, requests: {} }),
      readOrEmpty(config, resultsPath, { version: 1, entries: {} })
    ]);

    if (queue.json.version !== 1 || !queue.json.requests
      || Array.isArray(queue.json.requests)) {
      throw new Error('Invalid request queue.');
    }

    const old = result.json.entries?.[concert.id];
    const lastAttempt = getAttempt(old, concert);
    const pending = queue.json.requests[concert.id];
    const age = now - Date.parse(pending?.requestedAt);

    if (pending?.identity === identity(concert)
      && pending.requestId !== lastAttempt?.requestId
      && age >= 0 && age < 10 * 60000) {
      if ((pending.selectedEventId || null) !== selectedEventId) {
        throw new Error('Another check is running. Wait for it to finish.');
      }
      return pending;
    }

    if (!selectedEventId && lastAttempt?.identity === identity(concert)
      && now - Date.parse(lastAttempt?.lastAttemptAt) < 5 * 60000) {
      throw new Error('Please wait five minutes between checks.');
    }

    const request = {
      requestId: crypto.randomUUID(),
      requestedAt: new Date(now).toISOString(),
      identity: identity(concert),
      ...(selectedEventId ? { selectedEventId } : {})
    };

    queue.json.requests[concert.id] = request;

    try {
      await putFile(
        config, queuePath, queue.json, queue.sha,
        'Request: ' + label
      );
      return request;
    } catch (e) {
      if (!isConflictError(e) || attempt === 2) throw e;
    }
  }
}

export function attachTicketSwapCheck(host, concert, onUpdate, options = {}) {
  const {
    queuePath = QUEUE, resultsPath = RESULTS, getAttempt = entry => entry,
    label = 'Check TicketSwap', selectedEventId = null
  } = options;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'plain-act';
  button.textContent = label;

  const status = document.createElement('p');
  status.className = 'footnote';
  status.setAttribute('role', 'status');

  host.append(button, status);
  let busy = false;

  button.addEventListener('click', async event => {
    event.stopPropagation();
    if (busy) return;

    const config = getGithubConfig();
    if (!config?.token) {
      status.textContent = 'Connect GitHub in the app settings first.';
      return;
    }

    busy = true;
    button.disabled = true;
    status.textContent = 'Requesting a check…';

    try {
      const request = await requestCheck(config, concert, { queuePath, resultsPath, getAttempt, label, selectedEventId });
      if (!host.isConnected) return;

      status.textContent = 'Check requested. Waiting for the result…';
      const until = Date.now() + 10 * 60000;

      while (host.isConnected && Date.now() < until) {
        try {
          const { json } = await getFile(config, resultsPath);
          if (!host.isConnected) return;

          const entry = getAttempt(json.entries?.[concert.id], concert);
          if (entry?.requestId === request.requestId) {
            await onUpdate(json);
            status.textContent = entry.status === 'error'
              ? 'The check failed. Previous results are kept.'
              : 'Check completed.';
            return;
          }
        } catch (e) {
          if (e.status === 401 || e.status === 403) throw e;
          status.textContent =
            'Waiting for the result. Connection temporarily unavailable.';
        }

        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      if (host.isConnected) {
        status.textContent =
          `Still waiting. Reopen this card and press ${label} to check progress.`;
      }
    } catch (e) {
      if (host.isConnected) {
        status.textContent = e.status
          ? 'Could not request a check. Check your GitHub connection.'
          : e.message;
      }
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
}
