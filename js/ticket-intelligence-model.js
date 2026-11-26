import { getOfficialComparison, offerIsFresh, offerWasSuperseded } from './ticket-official.js';
import { identity } from './ticketswap-matching.js';

export const knownAmount = value => Number.isSafeInteger(value) && value >= 0;
export const validDate = value => Number.isFinite(Date.parse(value));

export function formatTicketMoney(value, currency = 'EUR') {
  if (!knownAmount(value) || !/^[A-Z]{3}$/.test(currency ?? '')) return 'Unknown';
  const format = new Intl.NumberFormat('en-IE', { style: 'currency', currency });
  return format.format(value / 10 ** format.resolvedOptions().maximumFractionDigits);
}

export function selectTicketEvidence(concert, swap, official, privateState, now = Date.now()) {
  const key = identity(concert);
  const entry = swap?.data.entries[concert.id];
  const record = official?.data.entries[concert.id];
  const resale = entry?.identity === key ? entry : null;
  const officialRecord = record?.identity === key ? record : null;
  const offers = [
    ...(officialRecord?.offers ?? []),
    ...Object.values(officialRecord?.providerChecks ?? {}).flatMap(check =>
      (check.offers ?? []).map(offer => ({ ...offer, sourceFailed: check.status === 'failed' })))
  ].filter(offer => validDate(offer?.verifiedAt))
    .sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt));
  const offerFresh = offer => !official?.stale && !offer.sourceFailed && offerIsFresh(offer.verifiedAt, now)
    && !offerWasSuperseded(offer, offers);
  const resaleStale = !!(swap?.stale || resale?.status === 'error' || (validDate(resale?.checkedAt) && !offerIsFresh(resale.checkedAt, now)));
  const comparable = resaleStale ? null : offers.map(offer => {
    const comparison = offerFresh(offer) && getOfficialComparison(offer, resale, now);
    return comparison ? { ...comparison, offer } : null;
  }).find(Boolean) ?? null;
  const offer = comparable?.offer ?? offers.find(offerFresh) ?? offers[0] ?? null;

  const state = privateState?.entries[concert.id];
  const observation = state?.observation;
  const watch = observation?.identity === key && observation.event?.id && observation.event.id === resale?.event?.id
    ? state : null;
  const demand = watch?.demand?.eventId === resale?.event?.id ? watch?.demand : null;
  const scopedSold = watch?.observation.soldSample;
  const sold = scopedSold ? { ...scopedSold, sampledAt: observation.checkedAt, scopedTypeId: observation.scopedTypeId }
    : watch?.soldSample && watch.soldSample.eventId === resale?.event?.id ? { ...watch.soldSample, sampledAt: watch.soldSample.observedAt } : null;

  return { resale, resaleStale, officialRecord, offers, offer, offerFresh: !!offer && offerFresh(offer),
    comparable, demand, sold, watch };
}

// Use only exact, explicitly labeled counts. Ranges, shorthand, "over" and
// unlabeled demand prose remain source text, and conflicts stay unknown.
export function parseTicketDemand(...texts) {
  const counts = { people: new Set(), tickets: new Set() };
  const patterns = {
    people: /^(?:([0-9]+) (?:people|persons?) (?:are )?waiting|([0-9]+) (?:mensen|personen) (?:op de wachtlijst|wachten))$/i,
    tickets: /^(?:([0-9]+) tickets? wanted|([0-9]+) tickets? gezocht)$/i
  };
  for (const raw of texts) {
    if (typeof raw !== 'string') continue;
    for (const line of raw.split(/\r?\n/)) {
      for (const [name, pattern] of Object.entries(patterns)) {
        const match = pattern.exec(line.trim().replace(/[.!]$/, ''));
        if (match) {
          const value = Number(match[1] ?? match[2]);
          if (knownAmount(value)) counts[name].add(value);
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(counts).map(([key, set]) => [key, set.size === 1 ? [...set][0] : null]));
}

export function ticketHistory(evidence, categoryId = '') {
  const { resale, offer, offers, watch } = evidence;
  const category = resale?.market?.categories?.find(item => item.id === categoryId);
  const market = (resale?.marketHistory ?? []).filter(point =>
    validDate(point.checkedAt) && (point.categoryId ?? '') === categoryId).map(point => ({
    at: point.checkedAt, cents: knownAmount(point.lowestPriceCents) ? point.lowestPriceCents : null,
    sampled: point.complete !== true || point.missingPrices === true
  }));
  if (!categoryId && resale?.currency === 'EUR' && validDate(resale.checkedAt)) {
    market.push({ at: resale.checkedAt, cents: knownAmount(resale.lowestPriceCents) ? resale.lowestPriceCents : null,
      sampled: resale.complete !== true || resale.missingPrices === true });
  }
  if (category && resale?.currency === 'EUR' && validDate(resale.checkedAt)) {
    market.push({ at: resale.checkedAt, cents: category.buyerPrices?.low ?? null,
      sampled: resale.complete !== true || category.activeListings !== category.buyerPrices?.listingsCounted });
  }
  const observed = watch?.observation;
  if (categoryId && observed?.currency === 'EUR' && observed.scopedTypeId === categoryId && validDate(observed.checkedAt)) {
    market.push({ at: observed.checkedAt, cents: observed.lowestPriceCents ?? null,
      sampled: observed.complete !== true || observed.missingPrices === true });
  }

  const anchor = categoryId ? offers.find(item => item.resaleTypeId === categoryId) : offer;
  const official = anchor ? offers.filter(item =>
    item.currency === 'EUR' && item.seller === anchor.seller && item.category === anchor.category
      && (!categoryId || item.resaleTypeId === categoryId) && item.feeInclusive === true
      && item.quantity === 1 && knownAmount(item.finalCents))
    .map(item => ({ at: item.verifiedAt, cents: item.finalCents, sampled: false })) : [];
  const chronological = rows => [...new Map(rows.map(row => [Date.parse(row.at), row])).values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return [
    { id: 'resale', label: 'TicketSwap observed low', points: chronological(market) },
    { id: 'official', label: 'Official all-in', points: chronological(official) }
  ];
}

export function ticketInsight(evidence) {
  const { comparable, resale, resaleStale } = evidence;
  if (comparable?.savingsCents > 0) return ['Below official price', 'An observed TicketSwap offer costs less for one equivalent ticket, including fees.'];
  if (comparable?.savingsCents < 0) return ['Official tickets offer better value', 'The verified official total is lower for one equivalent ticket.'];
  if (!resaleStale) {
    const market = ticketHistory(evidence)[0].points;
    const [previous, current] = market.slice(-2);
    if (previous && current && !previous.sampled && !current.sampled && knownAmount(current.cents) && current.cents < previous.cents
      && knownAmount(previous.cents)) {
      return ['Observed price moved down', `The lowest observed buyer price fell by ${formatTicketMoney(previous.cents - current.cents)} between the last two comparable checks.`];
    }
    if (resale?.complete === true && resale.availableTickets > 0 && resale.availableTickets <= 3) {
      return ['Limited observed availability', 'Three or fewer tickets were available at the last complete check.'];
    }
  }
  return ['Insufficient evidence', 'A current comparison needs verified prices for the same ticket category.'];
}
