import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { identity } from '../js/ticketswap-matching.js';
import { ticketSourceURL } from '../js/ticket-official.js';

export function recordOfficialOffer(store, concert, resale, input, now = Date.now()) {
  if (store?.version !== 1 || !store.entries || Array.isArray(store.entries)
    || typeof store.entries !== 'object') throw new Error('Invalid official ticket store');
  if (!concert?.id || input.concertId !== concert.id) throw new Error('Unknown planned concert');

  const requiredText = key => {
    const value = input[key]?.trim?.();
    if (!value || value.length > 240) throw new Error(`Invalid ${key}`);
    return value;
  };
  const purchaseUrl = ticketSourceURL(input.purchaseUrl);
  const sourceUrl = ticketSourceURL(input.sourceUrl);
  const checked = Date.parse(input.verifiedAt);
  if (!purchaseUrl || !sourceUrl || !Number.isFinite(checked) || checked > now) {
    throw new Error('Valid HTTPS evidence links and a verification timestamp are required');
  }
  if (!['available', 'sold-out', 'unknown'].includes(input.availability)
    || !Intl.supportedValuesOf('currency').includes(input.currency)) throw new Error('Invalid availability or currency');
  const price = key => {
    const amount = input[key] ?? null;
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) {
      throw new Error(`Invalid ${key}`);
    }
    return amount;
  };

  const concertIdentity = identity(concert);
  const resaleTypeId = input.resaleTypeId == null ? null : requiredText('resaleTypeId');
  if (resaleTypeId && (resale?.identity !== concertIdentity || !resale.event?.id
    || !resale.market?.categories?.some(category => category.id === resaleTypeId))) {
    throw new Error('The mapped TicketSwap category must exist for this concert');
  }

  const offer = {
    seller: requiredText('seller'),
    category: requiredText('category'),
    purchaseUrl,
    sourceUrl,
    evidence: requiredText('evidence'),
    verifiedAt: new Date(checked).toISOString(),
    quantity: input.quantity,
    availability: input.availability,
    currency: input.currency,
    faceCents: price('faceCents'),
    baseCents: price('baseCents'),
    feesCents: price('feesCents'),
    finalCents: price('finalCents'),
    feeInclusive: input.feeInclusive === true,
    resaleEventId: resaleTypeId ? resale.event.id : null,
    resaleTypeId,
    equivalenceEvidence: resaleTypeId ? requiredText('equivalenceEvidence') : null
  };
  if (offer.quantity !== 1) throw new Error('Supply an official quote for one ticket');
  if (offer.feeInclusive !== (offer.finalCents !== null)
    || (offer.baseCents !== null && offer.feesCents !== null && offer.finalCents !== null
      && offer.baseCents + offer.feesCents !== offer.finalCents)) {
    throw new Error('Final prices must be explicitly fee-inclusive and consistent with known components');
  }

  const old = store.entries[concert.id];
  const offers = old?.identity === concertIdentity ? old.offers : [];
  const sameOffer = item => item.category === offer.category && item.seller === offer.seller;
  if (offers.some(item => sameOffer(item) && Date.parse(item.verifiedAt) > checked)) {
    throw new Error('A newer verification exists for this seller and category');
  }
  return {
    ...store,
    updatedAt: new Date(now).toISOString(),
    entries: {
      ...store.entries,
      [concert.id]: { identity: concertIdentity, offers: [...offers.filter(item => !sameOffer(item)), offer] }
    }
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const path = 'data/official-ticket-offers.json';
  const lockPath = path + '.lock';
  const tmpPath = path + '.tmp';
  const lock = await open(lockPath, 'wx');
  try {
    const [planned, ticketSwap, store, input] = await Promise.all([
      readFile('data/planned.json', 'utf8'),
      readFile('data/ticketswap.json', 'utf8'),
      readFile(path, 'utf8'),
      readFile(process.argv[2], 'utf8')
    ]).then(values => values.map(value => JSON.parse(value)));
    const entry = planned.concerts.find(concert => concert.id === input.concertId);
    const saved = recordOfficialOffer(store, entry, ticketSwap.entries[input.concertId], input);
    await writeFile(tmpPath, JSON.stringify(saved, null, 2) + '\n');
    await rename(tmpPath, path);
    console.log('Recorded the supplied official-ticket evidence locally.');
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
