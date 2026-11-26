import { renderTicketWatch } from './ticket-watch-panel.js';
import { renderOfficialPanel } from './ticketswap-official-panel.js';
import { attachTicketSwapCheck } from './ticketswap-check.js?v=universal-ticket-match-20261015';
import { canConfirmTicketSwap, identity, ticketSwapURL } from './ticketswap-matching.js';
import { renderTicketSwapMarket } from './ticketswap-market.js';
import { createSnapshotCache } from './ticketswap-snapshot.js';

const snapshot = createSnapshotCache(async () => {
  const response = await fetch('data/ticketswap.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Snapshot unavailable');
  return response.json();
});

const officialOffers = createSnapshotCache(async () => {
  const response = await fetch('data/official-ticket-offers.json', {
    cache: 'no-store',
    signal: AbortSignal.timeout?.(5000)
  });
  if (!response.ok) throw new Error('Official offers unavailable');
  return response.json();
});

async function renderTicketSwap(host, concert, officialOpen = false) {
  if (!host) return;

  const [saved, official] = await Promise.allSettled([snapshot.load(), officialOffers.load()]);
  if (!host.isConnected) return;
  const evidence = official.status === 'fulfilled' ? official.value : null;
  const watchOpen = !!host.querySelector('.ticket-watch[open]');
  const watchPanel = entry => renderTicketWatch(concert, entry, [], undefined, watchOpen);
  const officialPanel = resale => renderOfficialPanel(concert, resale, evidence, async updated => {
    officialOffers.publish(updated);
    await renderTicketSwap(host, concert, true);
    host.querySelector('.official-ticket-check button')?.focus({ preventScroll: true });
  }, officialOpen || !!host.querySelector('.official-ticket-check[open]'));

  try {
    if (saved.status === 'rejected') throw saved.reason;
    const { data, stale: snapshotStale } = saved.value;
    const entry = data.entries?.[concert.id];
    if (!entry || entry.identity !== identity(concert)) {
      host.replaceChildren(document.createTextNode('This concert has not been checked yet.'),
        officialPanel(null), watchPanel(null));
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

    const summary = document.createElement('p');
    summary.className = 'footnote';
    summary.textContent = text;
    section.append(summary);

    if (entry.status === 'needs-review' || (entry.status === 'error' && !entry.event)) {
      const candidates = (entry.matchCandidates || []).filter(candidate =>
        canConfirmTicketSwap(concert, candidate));
      if (!candidates.length && entry.status === 'needs-review') summary.textContent = 'No event could be safely confirmed.';
      for (const candidate of candidates) {
        const candidateURL = ticketSwapURL(candidate.url);
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
            snapshot.publish(updated);
            await renderTicketSwap(host, concert);
          }, {
            selectedEventId: candidate.id,
            label: 'Use this event'
          });

          section.append(choice);
        }
      }
    }

    const checkedAt = Number.isSafeInteger(entry.availableTickets) ? Date.parse(entry.checkedAt) : NaN;
    if (Number.isFinite(checkedAt)) {
      const stale = snapshotStale || entry.status === 'error'
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

    if (snapshotStale) {
      const notice = document.createElement('p');
      notice.textContent = 'Could not refresh saved results.';
      section.append(notice);
    }

    if (entry.status === 'error') {
      const error = document.createElement('p');
      error.className = 'footnote';
      error.textContent = entry.lastError
        ? `Latest check failed: ${entry.lastError}`
        : 'Latest check failed.';
      section.append(error);
    }

    const url = ticketSwapURL(entry.event?.url);
    if (url) {
      const link = document.createElement('a');
      link.className = 'plain-act';
      link.textContent = 'TicketSwap ↗';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      section.append(link);
    }

    const market = renderTicketSwapMarket(entry);
    if (market) section.append(market);
    section.append(officialPanel(snapshotStale ? null : entry), watchPanel(entry));
    host.replaceChildren(section);
  } catch {
    host.replaceChildren(document.createTextNode('Could not load TicketSwap results. Close and try again.'),
      officialPanel(null), watchPanel(null));
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
    snapshot.publish(data);
    await renderTicketSwap(results, concert);
  });

  let loading = false;

  button.addEventListener('click', async event => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));

    if (panel.hidden || loading) return;

    loading = true;
    if (!results.childNodes.length) results.textContent = 'Loading saved results…';
    await renderTicketSwap(results, concert);
    loading = false;
  });

  panel.addEventListener('click', event => event.stopPropagation());
  host.replaceChildren(button, panel);
}
