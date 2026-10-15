import { attachTicketSwapCheck } from './ticketswap-check.js?v=universal-ticket-match-20261015';
let snapshotPromise;

const identity = c => JSON.stringify([
  c.artist, c.date, c.venue, c.city, c.country
]);

function safeURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:'
      && ['ticketswap.com', 'www.ticketswap.com'].includes(u.hostname)
      && !u.username && !u.password
      ? u.href : null;
  } catch {
    return null;
  }
}

async function renderTicketSwap(host, concert) {
  if (!host) return;

  try {
    snapshotPromise ||= fetch('data/ticketswap.json', { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('Snapshot unavailable');
        return r.json();
      })
      .catch(e => {
        snapshotPromise = null;
        throw e;
      });

    const data = await snapshotPromise;
    if (!host.isConnected) return;

    const entry = data.entries?.[concert.id];
    if (!entry || entry.identity !== identity(concert)) {
      host.textContent = 'This concert has not been checked yet.';
      return;
    }

    let text = 'Check unavailable';

    if (Number.isSafeInteger(entry.availableTickets)
      && entry.availableTickets >= 0) {
      if (entry.availableTickets === 0) {
        text = entry.complete
          ? 'No tickets available at last check'
          : 'No tickets in checked listings';
      } else {
        const count = entry.availableTickets;
        text = `${count}${entry.complete ? '' : '+'} ticket${count === 1 ? '' : 's'}`;

        if (Number.isSafeInteger(entry.lowestPriceCents)
          && entry.lowestPriceCents >= 0) {
          const price = new Intl.NumberFormat('en-IE', {
            style: 'currency',
            currency: 'EUR'
          }).format(entry.lowestPriceCents / 100);

          text += entry.complete && !entry.missingPrices
            ? ` · from ${price}`
            : ` · lowest seen ${price}`;
        }
      }
    } else if (entry.status === 'needs-review') {
      text = 'Choose the correct event once to check tickets and remember the match.';
    } else if (entry.status === 'search-incomplete') {
      text = 'No verified match in the returned search page. More results may exist.';
    } else if (entry.status === 'not-found') {
      text = 'No exact event match found';
    }

    const section = document.createElement('section');
    section.setAttribute('aria-label', 'TicketSwap availability');
    section.style.cssText =
      'border-top:1px solid var(--hair);padding:18px 0';

    const label = document.createElement('p');
    label.className = 'whisper';
    label.textContent = 'TicketSwap';

    const summary = document.createElement('p');
    summary.className = 'footnote';
    summary.textContent = text;
    section.append(summary);

    if (entry.status === 'needs-review') {
      for (const candidate of entry.matchCandidates || []) {
        const candidateURL = safeURL(candidate.url);
        if (!candidateURL) continue;

        const link = document.createElement('a');
        link.className = 'plain-act';
        link.style.display = 'block';
        link.textContent = [
          candidate.name, candidate.date, candidate.venue, candidate.city
        ].filter(Boolean).join(' · ') + ' ↗';
        link.href = candidateURL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        section.append(link);

        if (candidate.id) {
          const choice = document.createElement('div');

          attachTicketSwapCheck(choice, concert, async updated => {
            snapshotPromise = Promise.resolve(updated);
            await renderTicketSwap(host, concert);
          }, {
            selectedEventId: candidate.id,
            label: 'Use this event'
          });

          section.append(choice);
        }
      }
    }

    const checkedAt = Date.parse(entry.checkedAt);
    if (Number.isFinite(checkedAt)) {
      const stale = entry.status === 'error'
        || Date.now() - checkedAt > 6 * 3600000;

      const checked = document.createElement('p');
      checked.className = 'footnote';
      const when = new Date(checkedAt).toLocaleString('en-GB', {
        timeZone: 'Europe/Amsterdam',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });

      checked.textContent =
        `${stale ? 'Older result · ' : ''}Checked ${when} · availability may change`;
      section.append(checked);
    }

    if (entry.status === 'error') {
      const error = document.createElement('p');
      error.className = 'footnote';
      error.textContent = 'Latest check failed.';
      section.append(error);
    }

    const url = safeURL(entry.event?.url);
    if (url) {
      const link = document.createElement('a');
      link.className = 'plain-act';
      link.textContent = 'View on TicketSwap ↗';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      section.append(link);
    }

    host.replaceChildren(section);
  } catch {
    host.textContent = 'Could not load TicketSwap results. Close and try again.';
  }
}

export function mountTicketSwap(host, concert) {
  if (!host) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'plain-act';
  button.textContent = 'TicketSwap';
  button.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'footnote';
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'TicketSwap results');
  panel.setAttribute('aria-live', 'polite');

  const results = document.createElement('div');
  const controls = document.createElement('div');
  panel.append(results, controls);

  attachTicketSwapCheck(controls, concert, async data => {
    snapshotPromise = Promise.resolve(data);
    results.replaceChildren();
    await renderTicketSwap(results, concert);
  });

  let loading = false;

  button.addEventListener('click', async event => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));

    if (panel.hidden || loading || results.childNodes.length) return;

    loading = true;
    results.textContent = 'Loading saved results…';
    await renderTicketSwap(results, concert);
    loading = false;
  });

  panel.addEventListener('click', event => event.stopPropagation());
  host.replaceChildren(button, panel);
}
