import {
  getGithubConfig, getFile, putFile, isConflictError
} from './github-api.js';

const QUEUE = 'data/ticketswap-requests.json';
const RESULTS = 'data/ticketswap.json';
const identity = c => JSON.stringify([
  c.artist, c.date, c.venue, c.city, c.country
]);

async function readOrEmpty(config, path, empty) {
  try {
    return await getFile(config, path);
  } catch (e) {
    if (e.status === 404) return { json: empty };
    throw e;
  }
}

async function requestCheck(config, concert) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const [queue, result] = await Promise.all([
      readOrEmpty(config, QUEUE, { version: 1, requests: {} }),
      readOrEmpty(config, RESULTS, { version: 1, entries: {} })
    ]);

    if (queue.json.version !== 1 || !queue.json.requests
      || Array.isArray(queue.json.requests)) {
      throw new Error('Invalid request queue.');
    }

    const old = result.json.entries?.[concert.id];
    const pending = queue.json.requests[concert.id];
    const age = now - Date.parse(pending?.requestedAt);

    if (pending?.identity === identity(concert)
      && pending.requestId !== old?.requestId
      && age >= 0 && age < 10 * 60000) {
      return pending;
    }

    if (old?.identity === identity(concert)
      && now - Date.parse(old?.lastAttemptAt) < 5 * 60000) {
      throw new Error('Please wait five minutes between checks.');
    }

    const request = {
      requestId: crypto.randomUUID(),
      requestedAt: new Date(now).toISOString(),
      identity: identity(concert)
    };

    queue.json.requests[concert.id] = request;

    try {
      await putFile(
        config, QUEUE, queue.json, queue.sha,
        'Request TicketSwap check'
      );
      return request;
    } catch (e) {
      if (!isConflictError(e) || attempt === 2) throw e;
    }
  }
}

export function attachTicketSwapCheck(host, concert, onUpdate) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'plain-act';
  button.textContent = 'Check TicketSwap';

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
      const request = await requestCheck(config, concert);
      if (!host.isConnected) return;

      status.textContent = 'Check requested. Waiting for the result…';
      const until = Date.now() + 10 * 60000;

      while (host.isConnected && Date.now() < until) {
        try {
          const { json } = await getFile(config, RESULTS);
          if (!host.isConnected) return;

          const entry = json.entries?.[concert.id];
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
          'Still waiting. Reopen this card and press Check TicketSwap to check progress.';
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
