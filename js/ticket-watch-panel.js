import { identity, ticketSwapURL } from './ticketswap-matching.js';
import { offerIsFresh, ticketSourceURL, watchOfficialComparison } from './ticket-official.js';
import { WATCH_ALERTS, watchMarketMatch, watchPreferences, watchStopReason } from './ticket-watch.js';
import { changeWatch, readWatchData, readWatches, WATCH_CHANGED } from './ticket-watch-store.js';

const euros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
const price = cents => euros.format(cents / 100);
const formatDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
});

function node(tag, text) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  return item;
}

function button(label, type = 'button') {
  const item = node('button', label);
  item.className = 'plain-act';
  item.type = type;
  return item;
}

function actionLink(label, url) {
  const item = node('a', label);
  item.className = 'plain-act';
  item.href = url;
  item.target = '_blank';
  item.rel = 'noopener noreferrer';
  return item;
}

function disclosure(label) {
  const item = node('details');
  item.className = 'ticketswap-market ticket-watch';
  item.append(node('summary', label));
  return item;
}

export function renderTicketWatch(concert, entry, knownTypes = [], initialWatch) {
  const details = disclosure('Ticket Watch');
  const content = node('div');
  const feedback = node('p');
  feedback.setAttribute('role', 'status');
  details.append(content, feedback);
  const concertIdentity = identity(concert);
  let stored = initialWatch;
  let busy = false;

  async function save(change, message) {
    if (busy) return;
    busy = true;
    content.querySelectorAll('button').forEach(control => { control.disabled = true; });
    feedback.textContent = 'Saving watch…';
    try {
      stored = await changeWatch(concert.id, change);
      render();
      feedback.textContent = message;
      (content.querySelector('button') || details.querySelector('summary')).focus();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      busy = false;
      content.querySelectorAll('button').forEach(control => { control.disabled = false; });
    }
  }

  function render() {
    const watch = stored?.identity === concertIdentity ? stored : null;
    const stop = watchStopReason(concert);
    content.replaceChildren(node('p', stop || (watch?.paused ? 'Watch paused.' : watch
      ? 'Saved to your Watchlist.' : 'Save a ticket watch for this concert.')));
    if (!stop) {
      const form = node('form');
      const field = (label, control) => {
        const wrapper = node('label', label);
        wrapper.append(control);
        form.append(wrapper);
        return control;
      };
      const limit = field('Maximum all-in price per ticket (EUR)', node('input'));
      limit.inputMode = 'decimal';
      limit.placeholder = 'No limit';
      limit.value = watch?.maxCents != null ? (watch.maxCents / 100).toFixed(2) : '';
      const quantity = field('Ticket quantity', node('input'));
      Object.assign(quantity, { type: 'number', min: '1', max: '10', required: true, value: watch?.quantity ?? 1 });
      const category = field('Ticket category', node('select'));
      category.append(new Option('Any category', ''));
      const categories = new Map([...knownTypes.filter(type => type.eventId === entry?.event?.id),
        ...(entry?.market?.categories ?? [])].filter(type => type.id && type.title).map(type => [type.id, type.title]));
      if (watch?.categoryId && !categories.has(watch.categoryId)) categories.set(watch.categoryId, 'Saved category');
      for (const [id, title] of categories) category.append(new Option(title, id));
      category.value = watch?.categoryId ?? '';
      const alerts = node('fieldset');
      alerts.append(node('legend', 'Alert me when'));
      for (const [value, label] of Object.entries(WATCH_ALERTS)) {
        const box = node('input');
        Object.assign(box, { type: 'checkbox', value, checked: watch?.alerts.includes(value) ?? true });
        const wrapper = node('label');
        wrapper.append(box, document.createTextNode(label));
        alerts.append(wrapper);
      }
      form.append(alerts, button(watch ? 'Save watch settings' : 'Watch this concert', 'submit'));
      form.addEventListener('submit', event => {
        event.preventDefault();
        try {
          const preferences = watchPreferences({ maxPrice: limit.value, quantity: quantity.value, categoryId: category.value,
            alerts: [...alerts.querySelectorAll('input:checked')].map(input => input.value) });
          if (!watch) preferences.paused = false;
          save(current => {
            const old = current?.identity === concertIdentity ? current : null;
            const unchanged = old && ['maxCents', 'quantity', 'categoryId'].every(key => old[key] === preferences[key]);
            return {
              paused: old?.paused ?? false, ...preferences, identity: concertIdentity,
              watchId: old?.watchId ?? crypto.randomUUID(), revision: unchanged ? old.revision : crypto.randomUUID()
            };
          }, 'Watch saved.');
        } catch (error) {
          feedback.textContent = error.message;
        }
      });
      content.append(form);
      if (watch) {
        const toggle = button(watch.paused ? 'Resume watch' : 'Pause watch');
        toggle.addEventListener('click', () => save(current =>
          current?.watchId === watch.watchId ? { ...current, paused: !watch.paused } : current,
        watch.paused ? 'Watch resumed.' : 'Watch paused.'));
        content.append(toggle);
      }
    }
    if (stored) {
      const remove = button('Remove watch');
      remove.addEventListener('click', () => save(current => current?.watchId === stored.watchId ? null : current, 'Watch removed.'));
      content.append(remove);
    }
  }

  details.addEventListener('toggle', async () => {
    if (!details.open) return;
    if (stored !== undefined) { render(); return; }
    feedback.textContent = 'Loading watch…';
    try {
      stored = (await readWatches()).entries[concert.id] ?? null;
      render();
      feedback.textContent = '';
    } catch {
      feedback.textContent = 'Could not load your watch. Reopen this panel to retry.';
    }
  });
  return details;
}

function savedObservation(row, snapshot, watch) {
  const observed = row?.observation;
  const saved = snapshot?.identity === watch.identity ? snapshot : null;
  const compatible = observed?.identity === watch.identity
    && (!observed.scopedTypeId || observed.scopedTypeId === watch.categoryId) ? observed : null;
  return (Date.parse(saved?.checkedAt) || 0) > (Date.parse(compatible?.checkedAt) || 0) ? saved : compatible ?? saved;
}

function describeResult(entry, watch) {
  if (!Number.isSafeInteger(entry?.availableTickets)) return 'Availability unknown.';
  const time = Date.parse(entry.checkedAt);
  if (!Number.isFinite(time)) return 'Availability unknown.';
  const prefix = offerIsFresh(entry.checkedAt) ? '' : 'Stale · ';
  const incomplete = !entry.complete || !entry.market?.watchLotsKnown || entry.market.missingWatchLots || entry.missingPrices;
  const match = watchMarketMatch(watch, entry);
  const quantity = match.available === false ? 'No matching lot available'
    : match.available === true ? (match.buyerCents === null ? 'Matching lot observed · Price unknown'
      : `Matching lot observed · ${price(match.buyerCents)} each`) : 'Matching availability unknown';
  return `${prefix}${quantity}${incomplete ? ' · Incomplete coverage' : ''} · ${formatDate.format(time)}`;
}

export function renderTicketWatchList(concerts) {
  const panel = disclosure('Watchlist');
  panel.classList.add('ticket-watch-list');
  const body = node('div');
  const status = node('p');
  status.setAttribute('role', 'status');
  panel.append(status, body);
  let generation = 0;

  async function load() {
    const generationId = ++generation;
    status.textContent = 'Loading Watchlist…';
    try {
      const [watches, state, market, officialOffers] = await Promise.all([
        readWatches(),
        readWatchData('data/ticket-watch-state.json').catch(() => ({ entries: {} })),
        readWatchData('data/ticketswap.json').catch(() => ({ entries: {} })),
        readWatchData('data/official-ticket-offers.json').catch(() => ({ entries: {} }))
      ]);
      if (!panel.isConnected || generationId !== generation) return;
      body.replaceChildren();
      const rows = Object.entries(watches.entries).map(([id, watch]) =>
        [id, watch, concerts.find(concert => concert.id === id)])
        .sort((a, b) => (a[2]?.date ?? '').localeCompare(b[2]?.date ?? ''));
      const eligible = rows.filter(([, watch, concert]) => concert && watch.identity === identity(concert)
        && !watch.paused && !watchStopReason(concert)).length;
      status.textContent = 'Automatic monitoring is off. Checks run only when explicitly dispatched.';
      const estimate = state.estimate;
      body.append(node('p', eligible
        ? `Before budget limits, a pass over these ${eligible} active watches could cost up to ${2 * eligible} credits for availability. Reused IDs, batching and recent results can lower that estimate.`
        : 'No active watches. Estimated availability spend is 0 credits.'));
      if (estimate && Number.isFinite(Date.parse(estimate.estimatedAt))) {
        body.append(node('p', `Last scheduler estimate: ${estimate.credits} credits for ${estimate.due} due · ${estimate.reserve} protected · ${estimate.dailyLimit}/day, ${estimate.monthlyLimit}/month · ${formatDate.format(Date.parse(estimate.estimatedAt))}.`));
      }
      if (!rows.length) body.append(node('p', 'Open a Going concert to add it to your Watchlist.'));
      for (const [id, watch, concert] of rows) {
        const row = state.entries[id]?.watchId === watch.watchId ? state.entries[id] : null;
        const entry = savedObservation(row, market.entries[id], watch);
        const card = node('article');
        let savedIdentity = [];
        try { savedIdentity = JSON.parse(watch.identity); } catch {}
        card.append(node('h4', concert?.artist ?? savedIdentity[0] ?? 'Saved concert'));
        if (concert?.date || savedIdentity[1]) card.append(node('p', concert?.date ?? savedIdentity[1]));
        const stop = concert && watch.identity === identity(concert)
          ? watchStopReason(concert) : 'Concert no longer in Going';
        card.append(node('p', stop || (watch.paused ? 'Paused' : 'Active watch')));
        card.append(node('p', `${watch.quantity} ticket${watch.quantity === 1 ? '' : 's'} · ${watch.maxCents === null ? 'No price limit' : price(watch.maxCents) + ' max each'}`));
        if (watch.categoryId) {
          const category = entry?.market?.categories?.find(type => type.id === watch.categoryId)
            ?? row?.knownTypes?.find(type => type.id === watch.categoryId);
          card.append(node('p', category?.title ?? 'Saved category'));
        }
        if (row?.lastError || entry?.status === 'error') card.append(node('p', 'Latest check unavailable.'));
        card.append(node('p', describeResult(entry, watch)));
        const sold = entry?.soldSample ?? (row?.soldSample?.eventId === entry?.event?.id ? row?.soldSample : null);
        if (Number.isSafeInteger(sold?.medianCents)) {
          card.append(node('p', `SOLD listing sample median ${price(sold.medianCents)} · ${sold.listingsCounted} listings`));
        }
        if (row?.demand?.hasDemand === true && row.demand.eventId === entry?.event?.id
          && offerIsFresh(row.demand.checkedAt)) {
          card.append(node('p', row.demand.title || 'TicketSwap reports demand.'));
        }
        const venueLink = ticketSwapURL(entry?.event?.url);
        if (venueLink) card.append(actionLink('TicketSwap ↗', venueLink));
        const official = watch.quantity === 1
          ? watchOfficialComparison(officialOffers.entries[id], entry, watch.categoryId) : null;
        if (official && offerIsFresh(official.verifiedAt) && offerIsFresh(entry?.checkedAt) && !row.lastError) {
          const saving = official.savingsCents;
          const direction = saving > 0 ? 'TicketSwap' : 'Official';
          card.append(node('p', saving === 0 ? 'Verified single-ticket totals are equal.'
            : `${direction} ${official.sampled ? 'was' : 'is'} cheaper by ${price(Math.abs(saving))} for one equivalent ticket.`));
          const url = ticketSourceURL(official.purchaseUrl);
          if (url) card.append(actionLink('Official Tickets ↗', url));
        }
        const history = row?.monitor?.notifications ?? [];
        if (history.length) {
          const alerts = disclosure('Alert history');
          const list = node('ul');
          for (const item of [...history].reverse()) {
            list.append(node('li', `${WATCH_ALERTS[item.kind]} · ${formatDate.format(Date.parse(item.checkedAt))}${Number.isSafeInteger(item.buyerCents) ? ' · ' + price(item.buyerCents) : ''}`));
          }
          alerts.append(list);
          card.append(alerts);
        }
        if (concert) card.append(renderTicketWatch(concert, entry, row?.knownTypes, watch));
        else {
          const remove = button('Remove watch');
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            try { await changeWatch(id, current => current?.watchId === watch.watchId ? null : current); }
            catch (error) { status.textContent = error.message; remove.disabled = false; }
          });
          card.append(remove);
        }
        body.append(card);
      }
    } catch {
      status.textContent = 'Could not load Watchlist. Close and reopen to retry.';
    }
  }

  panel.addEventListener('toggle', () => { if (panel.open) load(); });
  // The Going pane is replaced on navigation. Observe owner lifetime rather than accumulating listeners.
  const observer = new MutationObserver(() => {
    if (panel.isConnected) return;
    window.removeEventListener(WATCH_CHANGED, changed);
    observer.disconnect();
  });
  const changed = () => { if (panel.open) load(); };
  window.addEventListener(WATCH_CHANGED, changed);
  observer.observe(document.body, { childList: true, subtree: true });
  return panel;
}
