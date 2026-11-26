import { getOfficialComparison, knownOfficialLink, offerIsFresh, offerWasSuperseded, ticketSourceURL } from './ticket-official.js';
import { identity, ticketSwapURL } from './ticketswap-matching.js';

function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function link(value, label) {
  const url = ticketSourceURL(value);
  if (!url) return null;
  const anchor = text('a', label);
  anchor.className = 'plain-act';
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

export function renderOfficialPanel(concert, resale, snapshot) {
  const record = snapshot?.data.entries[concert.id];
  const current = record?.identity === identity(concert) ? record : null;
  const checks = Object.values(current?.providerChecks ?? {});
  const offers = [
    ...(current?.offers ?? []),
    ...checks.flatMap(check => check.offers.map(offer => ({ ...offer, sourceFailed: check.status === 'failed' })))
  ].filter(offer => offer && (offer.currency === null || /^[A-Z]{3}$/.test(offer.currency)));
  const panel = document.createElement('details');
  panel.className = 'ticketswap-market';
  panel.append(text('summary', 'Official vs Resale'));

  if (!offers.length) {
    panel.append(text('p', 'Official price and availability: Not verified.'));
    if (checks.some(check => check.status === 'failed')) panel.append(text('p', 'The official source could not be refreshed.'));
    const official = link(knownOfficialLink(concert), 'Official Tickets ↗');
    if (official) panel.append(official);
    return panel;
  }

  for (const offer of offers) {
    const format = offer.currency && new Intl.NumberFormat('en-IE', { style: 'currency', currency: offer.currency });
    const divisor = format ? 10 ** format.resolvedOptions().maximumFractionDigits : 1;
    const money = value => !format || !Number.isSafeInteger(value) ? 'Unknown' : format.format(value / divisor);
    const fresh = !snapshot.stale && !offer.sourceFailed && offerIsFresh(offer.verifiedAt)
      && !offerWasSuperseded(offer, offers);
    const availability = offer.availability === 'sold-out' ? 'Sold out'
      : offer.availability === 'available' ? 'Available' : 'Unknown';
    panel.append(text('h4', `${offer.seller} · ${offer.category}`));
    const facts = document.createElement('dl');
    for (const [label, value] of [
      ['Official availability', fresh ? availability : 'Not verified'],
      ...(offer.listedCents == null ? [] : [['Published ticket price', money(offer.listedCents)]]),
      ['Official face value', money(offer.faceCents)],
      ['Official ticket price', money(offer.baseCents)],
      ['Official booking fees', money(offer.feesCents)],
      [fresh ? 'Official final price' : 'Last verified official final price', money(offer.finalCents)]
    ]) facts.append(text('dt', label), text('dd', value));
    panel.append(facts);
    const official = link(offer.purchaseUrl, 'Official Tickets ↗');
    const evidence = link(offer.sourceUrl, 'Verification source ↗');
    if (official) panel.append(official);
    if (evidence) panel.append(evidence);
    const verified = text('time', new Date(offer.verifiedAt).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam' }));
    verified.dateTime = offer.verifiedAt;
    const note = text('p', fresh ? 'Verified ' : 'Last verified ');
    note.append(verified, document.createTextNode(` · ${offer.evidence}`));
    panel.append(note);

    const comparison = fresh ? getOfficialComparison(offer, resale) : null;
    if (!comparison) {
      panel.append(text('p', 'Comparable current buyer totals are unavailable.'));
      continue;
    }
    const { buyerCents, listingUrl, savingsCents, savingsPercent, sampled } = comparison;
    panel.append(text('p', `Lowest ${sampled ? 'sampled ' : ''}TicketSwap buyer price for one ticket: ${money(buyerCents)}.`));
    if (savingsCents === 0) panel.append(text('p', 'Both buyer totals are the same.'));
    else {
      const channel = savingsCents > 0 ? 'TicketSwap is cheaper' : 'Official tickets are cheaper';
      panel.append(text('p',
        `${channel} by ${money(Math.abs(savingsCents))} (${Math.abs(savingsPercent).toFixed(1)}% of the official total).`));
    }
    panel.append(text('p', offer.equivalenceEvidence));
    const listing = link(ticketSwapURL(listingUrl), 'TicketSwap listing ↗');
    if (listing) panel.append(listing);
  }
  return panel;
}
