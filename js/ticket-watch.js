import { identity, canConfirmTicketSwap, ticketSwapURL } from './ticketswap-matching.js';

const hour = 3600000;
const localDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit'
});
export const WATCH_ALERTS = {
  available: 'Tickets available',
  threshold: 'At or below your price limit',
  drop: 'Price dropped',
  lastMinute: 'Last-minute opportunity'
};

export function concertDaysAway(concert, now) {
  return (Date.parse(concert.date) - Date.parse(localDay.format(now))) / (24 * hour);
}

export function watchStopReason(concert, now = Date.now()) {
  if (concert.practical?.ticketBought === true) return 'Tickets already owned';
  const days = (Date.parse(concert.endDate || concert.date) - Date.parse(localDay.format(now))) / (24 * hour);
  if (!Number.isFinite(days)) return 'Concert date unavailable';
  const scheduledEnd = (!concert.endDate || concert.endDate === concert.date)
    && concert.schedule?.date === concert.date ? Date.parse(concert.schedule.end?.at) : NaN;
  if (Number.isFinite(scheduledEnd) ? scheduledEnd <= now : days < 0) return 'Concert has passed';
  return null;
}

export function watchPreferences({ maxPrice, quantity, categoryId, alerts }) {
  const price = String(maxPrice ?? '').trim();
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(price);
  const maxCents = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
  const tickets = Number(quantity);
  if ((price && (maxCents === null || !Number.isSafeInteger(maxCents)))
    || !Number.isInteger(tickets) || tickets < 1 || tickets > 10) {
    throw new Error('Enter a quantity from 1 to 10 and a EUR price with up to two decimals.');
  }
  return {
    maxCents, quantity: tickets, categoryId: categoryId || null,
    alerts: Object.keys(WATCH_ALERTS).filter(key => alerts.includes(key))
  };
}

export function updateWatch(previous, concert, preferences) {
  const same = previous?.identity === identity(concert);
  const saved = same ? previous : {};
  const criteriaChanged = ['quantity', 'categoryId', 'maxCents'].some(key => saved[key] !== preferences[key]);
  return {
    ...saved, ...preferences, identity: identity(concert),
    paused: saved.paused ?? false,
    ...(criteriaChanged ? { signals: {}, previousPrice: null } : {})
  };
}

export function watchMarketMatch(watch, entry) {
  if (!entry?.market?.watchLotsKnown) return { available: null, buyerCents: null, knownPrice: false };
  const categories = entry.market.categories.filter(category => !watch.categoryId || category.id === watch.categoryId);
  const offers = categories.map(category => category.watchLots?.find(lot => lot.quantity === watch.quantity)).filter(Boolean);
  const prices = offers.map(offer => offer.buyerCents).filter(Number.isSafeInteger);
  const buyerCents = prices.length ? Math.min(...prices) : null;
  const categoryUnknown = watch.categoryId && entry.market.categories.some(category => !category.id);
  const coverage = entry.complete && !entry.market.missingWatchLots && !categoryUnknown;
  const knownPrice = coverage && offers.every(offer => !offer.missingPrice);
  const available = offers.length ? true : coverage ? false : null;
  return { available, buyerCents, knownPrice };
}

export function evaluateTicketWatch(watch, concert, entry, now = Date.now()) {
  const checked = Date.parse(entry?.checkedAt);
  if (!watch || watch.paused || watch.identity !== identity(concert) || watchStopReason(concert, now)
    || entry?.identity !== watch.identity || entry.status !== 'ok' || entry.currency !== 'EUR'
    || !entry.market?.watchLotsKnown || !entry.event?.id || !(now - checked >= 0 && now - checked <= 6 * hour)
    || checked <= (Date.parse(watch.lastCheckedAt) || 0)) return watch;

  const sameEvent = watch.eventId === entry.event.id;
  const signals = sameEvent ? { ...watch.signals } : {};
  const { available, buyerCents, knownPrice } = watchMarketMatch(watch, entry);
  const threshold = watch.maxCents === null ? false : buyerCents !== null && buyerCents <= watch.maxCents
    ? true : knownPrice ? false : null;
  const lastMinute = concertDaysAway(concert, now) <= 2
    ? watch.maxCents === null ? available : threshold : false;
  const previousPrice = sameEvent ? watch.previousPrice : null;
  const comparablePrice = knownPrice ? buyerCents : null;
  const notifications = [...(watch.notifications ?? [])];
  const conditions = { available, threshold, lastMinute };
  for (const [kind, active] of Object.entries(conditions)) {
    if (active === true && signals[kind] !== true && watch.alerts.includes(kind)) {
      notifications.push({ kind, checkedAt: entry.checkedAt, buyerCents });
    }
    if (active !== null) signals[kind] = active;
  }
  if (comparablePrice !== null && Number.isSafeInteger(previousPrice)
    && comparablePrice < previousPrice && watch.alerts.includes('drop')) {
    notifications.push({ kind: 'drop', checkedAt: entry.checkedAt, buyerCents, previousPrice });
  }
  return {
    ...watch, eventId: entry.event.id, lastCheckedAt: entry.checkedAt,
    signals, previousPrice: comparablePrice, notifications: notifications.slice(-12)
  };
}

export function planTicketWatchChecks(items, { now = Date.now(), spendableCredits = 0, batchSize = 0 } = {}) {
  if (!Number.isSafeInteger(spendableCredits) || spendableCredits <= 0) return [];
  const due = [];
  for (const { concert, watch, entry } of items) {
    if (!watch || watch.paused || watch.identity !== identity(concert) || watchStopReason(concert, now)) continue;
    const current = entry?.identity === watch.identity ? entry : null;
    const days = concertDaysAway(concert, now);
    const cadence = days <= 2 ? 2 : days <= 7 ? 6 : days <= 30 ? 24 : 72;
    const budgetFactor = spendableCredits <= 3 ? 3 : spendableCredits <= 8 ? 2 : 1;
    const interestFactor = watch.maxCents !== null || watch.categoryId ? 1 : 2;
    const intervalHours = cadence * budgetFactor * interestFactor;
    const latest = Math.max(Date.parse(current?.checkedAt) || 0, Date.parse(current?.lastAttemptAt) || 0);
    if (now - latest < intervalHours * hour) continue;
    const remembered = current?.event?.id && ticketSwapURL(current.event.url)
      && current.event.date === concert.date
      && (!current.event.confirmedByUser || canConfirmTicketSwap(concert, current.event));
    const typeId = watch.categoryId && current?.market?.categories?.some(category => category.id === watch.categoryId)
      ? watch.categoryId : null;
    due.push({ concertId: concert.id, days, intervalHours,
      eventId: remembered ? current.event.id : null, typeId,
      estimatedCredits: remembered ? 1 : 2 });

  }
  due.sort((a, b) => a.days - b.days || a.intervalHours - b.intervalHours
    || a.concertId.localeCompare(b.concertId));
  const bundled = new Set();
  return due.filter(item => {
    if (batchSize > 0 && item.eventId && item.typeId) {
      const key = item.eventId + ':' + item.typeId;
      if (bundled.has(key)) return true;
      if (bundled.size % batchSize === 0) {
        if (spendableCredits <= 0) return false;
        spendableCredits--;
      }
      bundled.add(key);
      return true;
    }
    if (item.estimatedCredits > spendableCredits) return false;
    spendableCredits -= item.estimatedCredits;
    return true;
  });
}
