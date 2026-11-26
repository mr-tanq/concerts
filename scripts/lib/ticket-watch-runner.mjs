import { watchOfficialComparison } from '../../js/ticket-official.js';
import { evaluateTicketWatch, planTicketWatchChecks, updateWatch, watchStopReason } from '../../js/ticket-watch.js';
import { identity } from '../../js/ticketswap-matching.js';
import { checkConcert } from './ticketswap-going.mjs';
import { summarizeListings } from './ticketswap-summary.mjs';
import { createTicketWatchAdapters } from './ticketswap-watch-api.mjs';

function batches(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

function latest(a, b) {
  return (Date.parse(b?.checkedAt) || 0) > (Date.parse(a?.checkedAt) || 0) ? b : a ?? b;
}

function soldStats(group, expectedEventId, expectedTypeId = null) {
  if (!group) return null;
  const seen = new Set();
  const prices = [];
  for (const listing of group.listings) {
    if (typeof listing?.id !== 'string' || seen.has(listing.id)
      || (listing.event?.id && listing.event.id !== expectedEventId)
      || (expectedTypeId && listing.ticket_type?.id && listing.ticket_type.id !== expectedTypeId)) continue;
    seen.add(listing.id);
    const amount = listing.converted_price?.total_price ?? listing.price?.total_price;
    if (amount?.currency === 'EUR' && Number.isSafeInteger(amount.amount) && amount.amount >= 0) {
      prices.push(amount.amount);
    }
  }
  prices.sort((a, b) => a - b);
  const middle = Math.floor(prices.length / 2);
  return { listingsCounted: prices.length, complete: group.complete && seen.size === prices.length,
    medianCents: prices.length ? prices[middle] - Math.floor((prices[middle] - prices[Math.floor((prices.length - 1) / 2)]) / 2) : null };
}

function batchObservation(result, item, now) {
  const type = result?.eventType;
  if (!result?.found || result.typeId !== item.typeId || type?.id !== item.typeId
    || type.event?.id !== item.eventId || !result.available) throw new Error('Ticket category not confirmed');
  const listings = result.available.listings.map(listing => {
    if (!listing || (listing.event?.id && listing.event.id !== item.eventId)
      || (listing.ticket_type?.id && listing.ticket_type.id !== item.typeId)) {
      throw new Error('Listing does not belong to the requested event and category');
    }
    return { ...listing, event: { id: item.eventId },
      ticket_type: { id: item.typeId, title: type.title } };
  });
  const summary = summarizeListings({ event_id: item.eventId, listing_status: 'AVAILABLE',
    page_info: { has_next_page: !result.available.complete }, listings });
  if (!summary.market.categories.length) {
    summary.market.categories.push({
      id: item.typeId, title: typeof type.title === 'string' ? type.title.slice(0, 160) : null,
      availableTickets: 0, activeListings: 0, watchLots: [], buyerPrices: summary.market.buyerPrices
    });
  }
  const time = new Date(now).toISOString();
  return { ...summary, identity: item.watch.identity, status: 'ok',
    event: item.source.event, scopedTypeId: item.typeId, checkedAt: time, lastAttemptAt: time,
    soldSample: soldStats(result.sold, item.eventId, item.typeId) };
}

function appropriate(entry, watch) {
  return entry?.identity === watch.identity && (!entry.scopedTypeId || entry.scopedTypeId === watch.categoryId)
    ? entry : null;
}

function rememberTypes(row) {
  const eventId = row.observation?.event?.id;
  if (!eventId) return;
  const learned = new Map((row.knownTypes ?? []).filter(type => type.eventId === eventId)
    .map(type => [type.id, type]));
  for (const category of row.observation.market?.categories ?? []) {
    if (category.id) learned.set(category.id, {
      id: category.id, title: category.title ?? learned.get(category.id)?.title ?? null, eventId
    });
  }
  row.knownTypes = [...learned.values()].slice(0, 100);
}

export async function runTicketWatches({
  concerts, watches, state, snapshot, official, spendableCredits,
  request, refreshWatches, now = Date.now(), mode = 'AVAILABLE_ONLY', enrich = false
}) {
  const cap = mode === 'FULL_MARKET' ? 5 : 10;
  const concertById = new Map(concerts.map(concert => [concert.id, concert]));
  const entries = Object.fromEntries(Object.entries(watches.entries).map(([id, watch]) => {
    const concert = concertById.get(id);
    const previous = state.entries[id]?.watchId === watch.watchId ? state.entries[id] : {};
    const matching = concert && watch.identity === identity(concert);
    const stop = matching ? watchStopReason(concert, now) : 'Concert no longer in Going';
    const sameSettings = previous.revision === watch.revision;
    const monitor = sameSettings ? { ...previous.monitor, ...watch }
      : updateWatch(previous.monitor, concert ?? {}, watch);
    const observation = matching ? latest(appropriate(previous.observation, watch), appropriate(snapshot.entries[id], watch)) : null;
    const recovered = observation?.status === 'ok'
      && Date.parse(observation.checkedAt) > Date.parse(previous.lastAttemptAt);
    return [id, {
      ...previous, concert, watch, monitor, observation, stop, revision: watch.revision, watchId: watch.watchId,
      ...(!sameSettings || recovered ? { failureCount: 0, retryAt: null, lastError: null } : {})
    }];
  }));

  if (!['AVAILABLE_ONLY', 'FULL_MARKET'].includes(mode)) throw new Error('Invalid watch monitoring mode');
  for (const row of Object.values(entries)) rememberTypes(row);
  const planned = planTicketWatchChecks(Object.values(entries).filter(row => !row.stop).map(row => {
    const knownTypes = row.knownTypes ?? [];
    let entry = row.observation;
    // Keep the remembered ID even when the preferred category was absent from the latest active page.
    if (row.watch.categoryId && entry?.event?.id && knownTypes.some(type => type.id === row.watch.categoryId && type.eventId === entry.event.id)) {
      const categories = entry.market?.categories ?? [];
      entry = { ...entry, market: { ...entry.market, categories: [...categories, { id: row.watch.categoryId }] } };
    }
    return { concert: row.concert, watch: row.watch, retryAt: row.retryAt, entry:
      row.lastAttemptAt && entry?.identity === row.watch.identity
        ? { ...entry, lastAttemptAt: [row.lastAttemptAt, entry.lastAttemptAt].filter(Boolean).sort().at(-1) }
        : row.lastAttemptAt ? { identity: row.watch.identity, lastAttemptAt: row.lastAttemptAt } : entry };
  }), { now, spendableCredits, batchSize: cap });
  const due = planned.map(item => ({ ...item, ...entries[item.concertId], source: entries[item.concertId].observation }));
  const batchItems = due.filter(item => item.typeId && item.eventId && item.source);
  const direct = due.filter(item => !batchItems.includes(item));
  const groups = batches([...new Set(batchItems.map(item => item.typeId))], cap);
  const coreEstimate = direct.reduce((total, item) => total + item.estimatedCredits, 0) + groups.length;
  const enrichmentEstimate = enrich && due.length ? Math.min(2, Math.max(0, spendableCredits - coreEstimate)) : 0;

  function recordAttempt(row, result) {
    row.lastAttemptAt = new Date(now).toISOString();
    if (result?.status === 'ok') {
      row.observation = result;
      rememberTypes(row);
      row.availabilityState = result.complete && !result.market?.missingWatchLots && !result.missingPrices
        ? 'checked' : 'incomplete';
      row.lastError = null;
      row.failureCount = 0;
      row.retryAt = null;
    } else {
      if (result?.event?.id && !row.observation) row.observation = result;
      row.availabilityState = result?.status === 'error' ? 'unavailable' : 'unknown';
      row.lastError = result?.status === 'error' ? 'Latest watch check failed.' : null;
      row.failureCount = row.lastError ? Math.min((row.failureCount ?? 0) + 1, 6) : 0;
      row.retryAt = row.failureCount
        ? new Date(now + Math.min(6 * 3600000, 900000 * 2 ** (row.failureCount - 1))).toISOString()
        : null;
    }
  }

  let stillAuthorized;
  if (request) {
    const deferred = message => [
      'Watch permissions changed.', 'TicketSwap credit budget exhausted',
      'TicketSwap checks temporarily paused', 'TicketSwap credit storage unavailable',
      'Could not save TicketSwap credit usage'
    ].includes(message);
    async function authorized(items) {
      if (!refreshWatches) return items;
      try {
        const current = (await refreshWatches()).entries;
        return items.filter(item => {
          const latest = current[item.concertId];
          const saved = item.watch;
          return latest && !latest.paused && latest.watchId === saved.watchId
            && latest.revision === saved.revision && latest.identity === saved.identity;
        });
      } catch {
        return [];
      }
    }
    const adapters = createTicketWatchAdapters(request);
    for (const types of groups) {
      const allowed = await authorized(batchItems.filter(candidate => types.includes(candidate.typeId)));
      if (!allowed.length) continue;
      let reply;
      try {
        reply = await adapters.marketBatch([...new Set(allowed.map(item => item.typeId))],
          { mode, ...(mode === 'FULL_MARKET' ? { soldFirst: 25 } : {}) });
      } catch (error) {
        if (deferred(error.message)) continue;
      }
      for (const item of allowed) {
        const results = reply?.results.filter(result => result.typeId === item.typeId) ?? [];
        try {
          if (results.length !== 1) throw new Error('Missing or ambiguous category response');
          recordAttempt(entries[item.concertId], batchObservation(results[0], item, now));
        } catch {
          recordAttempt(entries[item.concertId], { status: 'error' });
        }
      }
    }
    for (const item of direct) {
      const previous = latest(item.source, appropriate(snapshot.entries[item.concertId], item.watch));
      const guardedRequest = async (endpoint, params) => {
        if (!(await authorized([item])).length) throw new Error('Watch permissions changed.');
        return request(endpoint, params);
      };
      const result = await checkConcert(item.concert, previous, guardedRequest, new Date(now));
      if (!deferred(result.lastError)) recordAttempt(entries[item.concertId], result);
    }

    const known = await authorized(due.filter(item => entries[item.concertId].observation?.event?.id).slice(0, 10));
    if (enrichmentEstimate && known.length) {
      const ids = [...new Set(known.map(item => entries[item.concertId].observation.event.id))];
      try {
        const sample = await adapters.soldSample(ids);
        for (const item of known) {
          const row = entries[item.concertId];
          const eventId = row.observation.event.id;
          const result = sample.find(part => part.eventId === eventId && part.found);
          if (!result?.group) continue;
          row.soldSample = { ...soldStats(result.group, eventId), eventId, observedAt: new Date(now).toISOString() };
          const types = new Map((row.knownTypes ?? []).filter(type => type.eventId === eventId).map(type => [type.id, type]));
          for (const listing of result.group.listings) {
            const type = listing?.ticket_type;
            if (typeof type?.id !== 'string' || !type.id.trim()
              || (listing.event?.id && listing.event.id !== eventId)) continue;
            types.set(type.id, { id: type.id, title: typeof type.title === 'string' ? type.title.slice(0, 160) : null, eventId });
          }
          row.knownTypes = [...types.values()].slice(0, 100);
        }
      } catch {}
      if (enrichmentEstimate >= 2
        && (await authorized(known.filter(item => entries[item.concertId].observation.event.id === ids[0]))).length) {
        try {
          const demand = await adapters.eventDemand(ids[0]);
          for (const item of known.filter(item => entries[item.concertId].observation.event.id === ids[0])) {
            const { hasDemand, title, intro, recentlySold } = demand;
            entries[item.concertId].demand = { eventId: ids[0], hasDemand, title, intro, recentlySold, checkedAt: new Date(now).toISOString() };
          }
        } catch {}
      }
    }
    if (refreshWatches) {
      const current = await authorized(Object.entries(entries).map(([concertId, row]) => ({ concertId, watch: row.watch })));
      stillAuthorized = new Set(current.map(item => item.concertId));
    }
  }

  for (const row of Object.values(entries)) {
    if (!row.stop && (!stillAuthorized || stillAuthorized.has(row.concert.id))) {
      const entry = row.observation;
      row.monitor = evaluateTicketWatch(row.monitor, row.concert, entry, now);
      row.officialComparison = row.watch.quantity === 1
        ? watchOfficialComparison(official.entries[row.concert.id], entry, row.watch.categoryId, now) : null;
    }
    if (row.observation?.marketHistory) {
      const { marketHistory, ...observation } = row.observation;
      row.observation = observation;
    }
    delete row.concert;
    delete row.watch;
  }
  return {
    version: 1, updatedAt: new Date(now).toISOString(), entries,
    estimate: { credits: coreEstimate + enrichmentEstimate, due: planned.length, spendableCredits, mode }
  };
}
