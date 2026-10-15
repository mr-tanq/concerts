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

export async function mountTicketSwap(host, concert) {
  if (!host || concert.practical?.ticketBought === true) return;

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
    if (!host.isConnected || concert.practical?.ticketBought === true) return;

    const entry = data.entries?.[concert.id];
    if (!entry || entry.identity !== identity(concert)) return;

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
    section.append(label, summary);

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
    // Optional availability must never break Going.
  }
}
