import { renderTicketWatch } from './ticket-watch-panel.js';
import { renderOfficialPanel } from './ticketswap-official-panel.js';
import { attachTicketSwapCheck } from './ticketswap-check.js';
import { canConfirmTicketSwap, identity, ticketSwapURL } from './ticketswap-matching.js';
import { knownOfficialLink, offerIsFresh, ticketSourceURL, unverifiedTicketLink } from './ticket-official.js';
import { sellerSummary } from './ticket-links.js';
import { createSnapshotCache } from './ticketswap-snapshot.js';
import { readWatchConnection, readWatchData, readWatchState, WATCH_CHANGED } from './ticket-watch-store.js';
import { renderTicketHistory } from './ticket-intelligence-chart.js';
import { formatTicketMoney as money, knownAmount, parseTicketDemand, selectTicketEvidence, ticketInsight, validDate } from './ticket-intelligence-model.js';

const resaleCache = createSnapshotCache(() => readWatchData('data/ticketswap.json'));
const officialCache = createSnapshotCache(() => readWatchData('data/official-ticket-offers.json'));
const checkedTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
});
const concertDate = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
});
const timestamp = at => validDate(at) ? checkedTime.format(Date.parse(at)) : 'Awaiting verification';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(label, url, className) {
  if (!url) return null;
  const anchor = element('a', label, className);
  anchor.classList.add('ti-external');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function appendLink(host, label, url, className) {
  const anchor = link(label, url, className);
  if (anchor) host.append(anchor);
}

function facts(rows) {
  const list = element('dl', null, 'ti-facts');
  for (const [label, value] of rows) {
    list.append(element('dt', label), element('dd', value));
  }
  return list;
}

function section(title, id) {
  const view = element('section', null, 'ti-section');
  if (id) view.id = id;
  if (title) view.append(element('h2', title));
  return view;
}

function priceCard(title, value, label, status, date, details) {
  const card = element('article', null, 'ti-price');
  card.append(element('h3', title), element('p', value, 'ti-price-value'),
    element('p', label, 'ti-price-basis'), element('p', status, 'ti-price-status'),
    element('p', date, 'ti-muted'));
  if (details.length) card.append(facts(details));
  return card;
}

function amountRange(prices) {
  if (!knownAmount(prices?.low) || !knownAmount(prices.high)) return 'Unknown';
  return prices.low === prices.high ? money(prices.low) : `${money(prices.low)}–${money(prices.high)}`;
}

// Several official categories for one night are listed by name; the hero
// shows the one whose price it displays.
function categoryLabel(offer, offers) {
  const same = offers.filter(item => item.seller === offer.seller && item.verifiedAt === offer.verifiedAt);
  const named = offer.category && offer.category !== 'Category not stated' ? offer.category : 'Not stated';
  return same.length > 1 ? `${named} · ${same.length} categories` : named;
}

function priceHero(evidence, concert, officialSnapshot) {
  const { resale, resaleStale, offer, offerFresh, comparable, offers } = evidence;
  const grid = element('div', null, 'ti-prices');
  const advertised = offer?.listedCents;
  const final = offer?.feeInclusive === true ? offer.finalCents : null;
  const currency = offer?.currency ?? null;
  const priceAvailable = knownAmount(final) || knownAmount(advertised);
  const officialStatus = !offerFresh ? offer ? 'Availability unverified' : 'Not verified'
    : ({ available: 'Available', 'sold-out': 'Sold out' }[offer.availability] ?? 'Availability unknown');
  const official = priceCard('Official tickets', money(final ?? advertised, currency),
    !priceAvailable ? 'No verified price' : knownAmount(final) ? 'All-in for one ticket' : 'Advertised price',
    officialStatus, offer ? (offerFresh ? 'Verified ' : 'Last verified ') + timestamp(offer.verifiedAt) : 'Awaiting verification', offer ? [
      ['Seller', offer.seller || 'Unknown'],
      ['Category', categoryLabel(offer, offers)],
      ['Advertised', money(advertised, currency)],
      ...(knownAmount(offer.baseCents) ? [['Ticket price', money(offer.baseCents, currency)]] : []),
      ['Fees', knownAmount(offer.feesCents) ? money(offer.feesCents, currency)
        : offer.priceContext?.serviceFeesIncluded ? 'Service fees included' : 'Unknown'],
      ['All-in total', money(final, currency)]
    ] : []);
  if (offer?.priceContext?.serviceFeesIncluded) {
    official.append(element('p', knownAmount(offer.feesCents)
      ? `Advertised price includes ${money(offer.feesCents, currency)} service fees. Checkout charges are not verified.`
      : 'Advertised price includes service fees. Checkout charges are not verified.', 'ti-muted'));
  }
  const seller = sellerSummary(evidence.officialRecord, identity(concert), concert.ticketUrl);
  if (offer?.availabilityConflict) official.append(element('p', 'Conflicting stock evidence: availability not confirmed.', 'ti-muted'));
  // Without an offer, say where the seller stands; an offer already names it.
  if (!offer) official.append(element('p', seller.text, 'ti-muted ti-seller'));
  if (knownAmount(offer?.priceContext?.excludedMembershipCents)) {
    official.append(element('p', `${money(offer.priceContext.excludedMembershipCents, currency)} membership excluded.`, 'ti-muted'));
  }

  const count = resale?.availableTickets;
  const complete = resale?.complete === true;
  const availability = !knownAmount(count) ? 'Availability unknown' : !count && !complete ? 'No tickets seen in sample'
    : !count ? 'None available at check' : `${count}${complete ? '' : '+'} available at check`;
  const low = resale?.currency === 'EUR' ? resale.lowestPriceCents : null;
  const categories = resale?.market?.categories ?? [];
  const lowest = categories.filter(category => knownAmount(low) && category.buyerPrices?.low === low);
  const resaleCard = priceCard('TicketSwap', money(low), knownAmount(low) ? 'Lowest observed buyer total' : 'No observed buyer total',
    availability, validDate(resale?.checkedAt) ? (resaleStale ? 'Older result · ' : 'Checked ') + timestamp(resale.checkedAt) : 'Awaiting verification',
    resale ? [['Category', lowest.length === 1 ? lowest[0].title || 'Unknown' : 'Unknown'],
      ['Coverage', !knownAmount(count) ? 'Unknown' : complete && !resale.missingPrices ? 'Complete check' : 'Partial sample'],
      ['Seller asking', money(resale?.market?.cheapest?.sellerCents)]] : []);
  grid.append(official, resaleCard);

  const hero = element('div');
  hero.append(grid);
  if (comparable) {
    const difference = comparable.savingsCents;
    const summary = element('div', null, 'ti-saving' + (difference > 0 ? ' ti-saving-positive' : ''));
    const title = difference === 0 ? 'Equivalent totals'
      : `${difference > 0 ? 'TicketSwap' : 'Official'} · ${money(Math.abs(difference))} less`;
    summary.append(element('strong', title));
    const percent = difference === 0 ? '' : ` · ${Math.abs(comparable.savingsPercent).toFixed(1)}% of official total`;
    summary.append(element('span', `${comparable.offer.category} · one ticket${percent}${comparable.sampled ? ' · observed sample' : ''}`));
    appendLink(summary, 'Comparable listing', ticketSwapURL(comparable.listingUrl), 'ti-evidence-link');
    hero.append(summary);
  }
  if (offers.length || evidence.officialRecord?.lastCheck) {
    const sources = renderOfficialPanel(concert, resaleStale ? null : resale, officialSnapshot);
    sources.querySelector('summary').textContent = 'Official offer evidence';
    sources.classList.add('ti-evidence');
    hero.append(sources);
  }
  return hero;
}

function marketOverview(evidence) {
  const view = section('Market overview', 'ticket-intelligence-market');
  const { resale, resaleStale, demand, sold } = evidence;
  const market = resale?.market;
  const counts = demand && demand.hasDemand !== false && offerIsFresh(demand.checkedAt) ? parseTicketDemand(demand.title, demand.intro) : {};
  const categories = (market?.categories ?? []).filter(category => category.id && category.title);
  const stats = [
    ['Reported face value', money(market?.cheapest?.originalCents)],
    ['Resale price range', amountRange(market?.buyerPrices)],
    ['Buyer median', money(market?.buyerPrices?.median)],
    ['SOLD listing median', money(sold?.medianCents), sold ? `${sold.listingsCounted} ${sold.scopedTypeId ? 'category listings' : 'sampled listings'}` : 'No saved sample'],
    ['Available tickets', knownAmount(resale?.availableTickets)
      ? String(resale.availableTickets) + (resale.complete ? '' : resale.availableTickets ? '+' : ' seen') : 'Unknown'],
    ['People waiting', counts.people ?? 'Unknown'],
    ['Tickets wanted', counts.tickets ?? 'Unknown'],
    ['Ticket categories', categories.length || 'Unknown', categories.length ? 'Named in this view' : null]
  ];
  const grid = element('dl', null, 'ti-stat-grid');
  for (const [label, value, detail] of stats) {
    const stat = element('div');
    stat.append(element('dt', label), element('dd', value));
    if (detail) stat.append(element('dd', detail, 'ti-muted'));
    grid.append(stat);
  }
  view.append(grid);
  if (resale && validDate(resale.checkedAt)) {
    view.append(element('p', `${resaleStale ? 'Older observation' : resale.complete && !resale.missingPrices ? 'Complete check' : 'Partial observation'} · ${timestamp(resale.checkedAt)}`, 'ti-muted'));
  }
  if (sold) view.append(element('p', `SOLD listings are marketplace samples. Completed transactions are unconfirmed. Sample checked ${timestamp(sold.sampledAt)}.`, 'ti-muted'));
  const cheapest = market?.cheapest;
  if (cheapest) {
    const disclosure = element('details', null, 'ti-evidence');
    disclosure.append(element('summary', 'Lowest offer breakdown'), facts([
      ['Total buyer price', money(cheapest.buyerTotalCents)], ['Seller asking price', money(cheapest.sellerCents)],
      ['Buyer–seller difference', money(cheapest.feeDifferenceCents)], ['Reported face value', money(cheapest.originalCents)]
    ]));
    appendLink(disclosure, 'Open listing', ticketSwapURL(cheapest.url), 'ti-evidence-link');
    view.append(disclosure);
  }
  return view;
}

function supplyDemand(evidence) {
  const view = section('Supply & demand');
  const { resale, demand } = evidence;
  const categories = resale?.market?.categories ?? [];
  const layout = element('div', null, 'ti-supply-grid');
  const supply = element('div');
  supply.append(element('h3', 'Available by category'));
  if (!categories.length) supply.append(element('p', 'No category-level supply recorded.', 'ti-muted'));
  const peak = Math.max(1, ...categories.map(category => Number(category.availableTickets) || 0));
  for (const category of categories) {
    if (!knownAmount(category.availableTickets)) continue;
    const item = element('div', null, 'ti-supply-row');
    item.append(element('span', category.title || 'Unidentified category'),
      element('strong', String(category.availableTickets) + (!resale.complete && category.availableTickets ? '+' : '')));
    const bar = element('div', null, 'ti-supply-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = element('span');
    fill.style.width = 100 * category.availableTickets / peak + '%';
    bar.append(fill);
    item.append(bar);
    const range = amountRange(category.buyerPrices);
    if (range !== 'Unknown') item.append(element('p', range + ' observed', 'ti-muted'));
    supply.append(item);
  }

  const waiting = element('div');
  waiting.append(element('h3', 'Waiting-list signals'));
  if (!demand) waiting.append(element('p', 'No verified demand sample is saved for this event.', 'ti-muted'));
  else {
    waiting.append(element('p', `${offerIsFresh(demand.checkedAt) ? 'Checked' : 'Older sample ·'} ${timestamp(demand.checkedAt)}`, 'ti-muted'));
    const sourceText = [...new Set([demand.title, demand.intro, demand.recentlySold].filter(Boolean))];
    for (const source of sourceText) waiting.append(element('p', source, 'ti-source-text'));
    for (const type of demand.types ?? []) {
      const levels = type.priceLevels ?? [];
      if (!levels.length) continue;
      waiting.append(element('h4', type.title || 'Unidentified category'));
      for (const level of levels) {
        const price = level.convertedPrice ?? level.price;
        const value = price?.currency === 'EUR' && knownAmount(price.amount) ? money(price.amount) : null;
        if (level.text || value) waiting.append(element('p', [level.text, value].filter(Boolean).join(' · '), 'ti-source-text'));
      }
    }
    waiting.append(element('p', 'People waiting and tickets wanted are reported separately from available supply.', 'ti-muted'));
  }
  layout.append(supply, waiting);
  view.append(layout);
  return view;
}

function createDashboard(concert, artwork, launcher) {
  const dialog = element('dialog', null, 'ticket-intelligence');
  dialog.setAttribute('aria-labelledby', 'ticket-intelligence-artist');
  const chrome = element('div', null, 'ti-chrome');
  chrome.append(element('span', 'Ticket Intelligence', 'ti-kicker'));
  const close = element('button', 'Close ×', 'ti-close');
  close.type = 'button';
  close.autofocus = true;
  close.setAttribute('aria-label', 'Close Ticket Intelligence');
  chrome.append(close);

  const scroller = element('div', null, 'ti-scroll');
  const mast = element('header', null, 'ti-mast');
  try {
    const url = new URL(artwork, document.baseURI);
    if (artwork && (url.protocol === 'https:' || url.origin === location.origin)) {
      const image = element('img', null, 'ti-artwork');
      image.alt = '';
      image.src = url.href;
      image.addEventListener('error', () => image.remove());
      mast.append(image);
      mast.classList.add('ti-has-artwork');
    }
  } catch {}
  const billing = element('div', null, 'ti-billing');
  const artist = element('h1', concert.artist || 'Concert');
  artist.id = 'ticket-intelligence-artist';
  const date = validDate(concert.date) ? concertDate.format(Date.parse(concert.date)) : null;
  billing.append(artist, element('p', [date, concert.venue, concert.city].filter(Boolean).join(' · '), 'ti-concert-line'));
  const updated = element('p', 'Loading saved verifications…', 'ti-last-verified');
  billing.append(updated);
  mast.append(billing);
  scroller.append(mast);

  const nav = element('nav', null, 'ti-nav');
  nav.setAttribute('aria-label', 'Ticket Intelligence sections');
  const main = element('div', null, 'ti-main');
  const overview = section(null, 'ticket-intelligence-overview');
  const market = element('div');
  const chart = section(null, 'ticket-intelligence-history');
  const watch = section('Smart Ticket Watch', 'ticket-intelligence-watch');
  const watchControls = element('div');
  watch.append(watchControls);
  for (const [label, target] of [['Overview', overview], ['Market', market], ['History', chart], ['Watch', watch]]) {
    const button = element('button', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      nav.querySelectorAll('button').forEach(item => item.removeAttribute('aria-current'));
      button.setAttribute('aria-current', 'location');
      target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
    nav.append(button);
  }
  nav.firstElementChild.setAttribute('aria-current', 'location');
  scroller.append(nav, main);

  const requests = element('div', null, 'ti-verification');
  const officialCheck = element('div');
  const resaleCheck = element('div');
  requests.append(officialCheck, resaleCheck);
  requests.setAttribute('aria-label', 'Request an explicit check');
  attachTicketSwapCheck(officialCheck, concert, async data => {
    officialCache.publish(data);
    await load();
  }, {
    label: 'Check official tickets', queuePath: 'data/official-ticket-requests.json',
    resultsPath: 'data/official-ticket-offers.json',
    getAttempt: entry => entry?.lastCheck?.identity === identity(concert) ? entry.lastCheck : null
  });
  attachTicketSwapCheck(resaleCheck, concert, async data => {
    resaleCache.publish(data);
    await load();
  });

  const loader = element('div', null, 'ti-loading');
  loader.setAttribute('role', 'status');
  loader.append(element('p', 'Loading saved ticket intelligence…'));
  const placeholders = element('div', null, 'ti-prices');
  placeholders.setAttribute('aria-hidden', 'true');
  placeholders.append(element('span'), element('span'));
  loader.append(placeholders);
  watch.hidden = true;
  overview.append(loader, requests);
  const footer = element('footer', null, 'ti-footer');
  main.append(overview, market, chart, watch);
  dialog.append(chrome, scroller, footer);

  let generation = 0;
  let mountedWatch = false;
  let privateState = null;
  let privateGeneration = 0;
  async function load({ refreshPrivate = true } = {}) {
    const id = ++generation;
    const connection = readWatchConnection();
    if (refreshPrivate && connection) {
      const requestId = ++privateGeneration;
      readWatchState().then(data => {
        const current = readWatchConnection();
        if (requestId !== privateGeneration || !dialog.open
          || current?.repository !== connection.repository || current?.token !== connection.token) return;
        privateState = data;
        load({ refreshPrivate: false });
      }).catch(() => {});
    }
    const [saved, official] = await Promise.allSettled([resaleCache.load(), officialCache.load()]);
    if (!dialog.isConnected || !dialog.open || generation !== id) return;
    const swap = saved.status === 'fulfilled' ? saved.value : null;
    const source = official.status === 'fulfilled' ? official.value : null;
    const evidence = selectTicketEvidence(concert, swap, source, privateState);
    const { resale, resaleStale, offer, comparable } = evidence;
    const times = [resale?.checkedAt, ...evidence.offers.map(item => item.verifiedAt)].filter(validDate);
    const last = times.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    updated.textContent = last ? 'Last successful check · ' + timestamp(last) + ' CET/CEST' : 'No successful verification saved';

    const messages = [];
    if (!swap) messages.push('Saved TicketSwap results could not be loaded.');
    if (!source) messages.push('Saved official results could not be loaded.');
    if (swap?.stale || source?.stale) messages.push('Saved evidence is shown while a source is unavailable.');
    if (resale?.status === 'error') messages.push('Latest TicketSwap check failed. The prior observation is retained when available.');
    if (resale?.status === 'search-incomplete') messages.push('The returned search page did not confirm an event.');
    if (resale?.status === 'not-found') messages.push('No exact TicketSwap event match was found.');
    const hero = priceHero(evidence, concert, source);
    overview.replaceChildren(hero, requests);
    if (messages.length) {
      const notice = element('p', messages.join(' '), 'ti-notice');
      notice.setAttribute('role', 'status');
      overview.prepend(notice);
    }
    if (resale?.status === 'needs-review' || (resale?.status === 'error' && !resale.event)) {
      const match = element('div', null, 'ti-match');
      match.append(element('h3', 'Confirm the TicketSwap event'));
      const candidates = (resale.matchCandidates ?? []).filter(item => canConfirmTicketSwap(concert, item));
      if (!candidates.length) match.append(element('p', 'No event can be safely confirmed from the saved search.', 'ti-muted'));
      for (const candidate of candidates) {
        const item = element('div');
        appendLink(item, [candidate.name, candidate.date, candidate.venue, candidate.city].filter(Boolean).join(' · '),
          ticketSwapURL(candidate.url), 'ti-evidence-link');
        attachTicketSwapCheck(item, concert, async data => {
          resaleCache.publish(data);
          await load();
          resaleCheck.querySelector('button')?.focus({ preventScroll: true });
        }, { selectedEventId: candidate.id, label: 'Use this event' });
        match.append(item);
      }
      overview.append(match);
    }

    const [insight, explanation] = ticketInsight(evidence);
    const insightPanel = element('section', null, 'ti-insight');
    insightPanel.append(element('h2', 'Market insight', 'ti-kicker'), element('h3', insight), element('p', explanation));
    overview.append(insightPanel);
    market.replaceChildren(marketOverview(evidence), supplyDemand(evidence));
    chart.dispatchEvent(new Event('ticket-chart-reset'));
    chart.replaceChildren();
    renderTicketHistory(chart, evidence);

    if (!mountedWatch) {
      const embedded = renderTicketWatch(concert, resale, [], undefined, true, true);
      watchControls.replaceChildren(embedded);
      mountedWatch = true;
      watch.hidden = false;
    } else {
      watchControls.firstElementChild?.dispatchEvent(new CustomEvent('ticket-watch-evidence', { detail: resale }));
    }

    footer.replaceChildren();
    const officialURL = ticketSourceURL(offer?.purchaseUrl) || knownOfficialLink(concert, evidence.officialRecord);
    appendLink(footer, 'Official tickets', officialURL, 'ti-purchase ti-purchase-primary');
    // Automated verification failed or never ran: keep the stored link
    // reachable, clearly marked as unverified.
    const fallback = officialURL ? null : unverifiedTicketLink(concert);
    if (fallback) appendLink(footer, fallback.label, fallback.url, 'ti-purchase ti-purchase-unverified');
    appendLink(footer, 'TicketSwap', ticketSwapURL(resale?.event?.url), 'ti-purchase');
    if (!footer.childNodes.length) footer.append(element('p', 'Purchase links appear when a source is identified.', 'ti-muted'));
    if (resaleStale && validDate(resale?.checkedAt)) footer.classList.add('ti-footer-stale');
    else footer.classList.remove('ti-footer-stale');
  }

  const priorOverflow = document.documentElement.style.overflow;
  const before = { x: scrollX, y: scrollY };
  const disconnected = () => {
    if (!readWatchConnection() && dialog.open) {
      ++privateGeneration;
      privateState = null;
      chart.dispatchEvent(new Event('ticket-chart-reset'));
      watchControls.replaceChildren(renderTicketWatch(concert, null, [], undefined, true, true));
      load();
    }
  };
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
  dialog.addEventListener('close', () => {
    window.removeEventListener(WATCH_CHANGED, disconnected);
    chart.dispatchEvent(new Event('ticket-chart-reset'));
    dialog.remove();
    document.documentElement.style.overflow = priorOverflow;
    launcher.focus({ preventScroll: true });
    scrollTo(before.x, before.y);
  }, { once: true });

  document.body.append(dialog);
  dialog.showModal(); // back-nav.js owns the native dialog's history entry.
  document.documentElement.style.overflow = 'hidden';
  window.addEventListener(WATCH_CHANGED, disconnected);
  close.focus({ preventScroll: true });
  load();
}

export function mountTicketSwap(host, concert, artwork) {
  if (!host) return;
  const button = element('button', 'Ticket Intelligence', 'plain-act ticket-intelligence-entry');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-label', 'Ticket Intelligence');
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (!document.querySelector('.ticket-intelligence[open]')) createDashboard(concert, artwork, button);
  });
  host.replaceChildren(button);
}
