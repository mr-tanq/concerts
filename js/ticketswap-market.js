import { ticketSwapURL } from './ticketswap-matching.js';

const euros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
const times = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit'
});
const knownPrice = value => Number.isSafeInteger(value) && value >= 0;
const formatPrice = value => knownPrice(value) ? euros.format(value / 100) : 'Unknown';

function textElement(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function appendFact(list, label, value) {
  list.append(textElement('dt', label), textElement('dd', value));
}

function priceRange(stats) {
  if (!knownPrice(stats.low)) return 'Unknown';
  return stats.low === stats.high ? formatPrice(stats.low)
    : `${formatPrice(stats.low)} – ${formatPrice(stats.high)}`;
}

function renderHistory(points) {
  const history = document.createElement('div');
  history.append(textElement('h4', 'Observed price history'));
  if (points.length < 2) {
    history.append(textElement('p', 'Price history appears after two successful checks.'));
    return history;
  }

  const max = Math.max(1, ...points.map(point => knownPrice(point.lowestPriceCents) ? point.lowestPriceCents : 0));
  const chart = document.createElement('ol');
  chart.className = 'ticketswap-history';
  for (const point of points) {
    const date = Date.parse(point.checkedAt);
    if (!Number.isFinite(date)) continue;
    const row = document.createElement('li');
    const time = textElement('time', times.format(date));
    time.dateTime = point.checkedAt;

    const price = point.lowestPriceCents;
    const sampled = !point.complete || point.missingPrices;
    const value = knownPrice(price)
      ? `${formatPrice(price)}${sampled ? ' (sample)' : ''}`
      : point.complete && point.availableTickets === 0 ? 'No availability' : 'Unknown';
    row.append(time, textElement('span', value));
    if (knownPrice(price)) {
      const bar = document.createElement('span');
      bar.className = 'ticketswap-history-bar';
      bar.classList.toggle('is-sampled', sampled);
      bar.style.width = `${Math.max(1, price / max * 100)}%`;
      bar.setAttribute('aria-hidden', 'true');
      row.append(bar);
    }
    chart.append(row);
  }
  history.append(chart);

  const [previous, latest] = points.slice(-2);
  const comparable = [previous, latest].every(point =>
    point.complete && !point.missingPrices && knownPrice(point.lowestPriceCents));
  if (comparable && latest.lowestPriceCents < previous.lowestPriceCents) {
    history.append(textElement('p',
      `The lowest observed buyer price fell by ${formatPrice(previous.lowestPriceCents - latest.lowestPriceCents)} between the last two checks.`));
  }
  return history;
}

export function renderTicketSwapMarket(entry) {
  const market = entry.market;
  if (!market) return null;

  const details = document.createElement('details');
  details.className = 'ticketswap-market';
  details.append(textElement('summary', 'Market details'));

  const prices = market.buyerPrices;
  const scope = entry.complete && !entry.missingPrices ? 'Returned listings' : 'Sampled listings';
  const facts = document.createElement('dl');
  appendFact(facts, 'Buyer price range', priceRange(prices));
  appendFact(facts, 'Buyer median', formatPrice(prices.median));
  details.append(facts, textElement('p',
    `${scope} · ${prices.listingsCounted} of ${market.activeListings} with a valid EUR buyer total`));

  const cheapest = market.cheapest;
  if (cheapest) {
    details.append(textElement('h4', 'Lowest observed offer'));
    const breakdown = document.createElement('dl');
    appendFact(breakdown, 'Buyer total', formatPrice(cheapest.buyerTotalCents));
    appendFact(breakdown, 'Seller asking price', formatPrice(cheapest.sellerCents));
    appendFact(breakdown, 'TicketSwap-reported face value', formatPrice(cheapest.originalCents));
    appendFact(breakdown, 'Buyer–seller price difference', formatPrice(cheapest.feeDifferenceCents));
    details.append(breakdown);

    const url = ticketSwapURL(cheapest.url);
    if (url) {
      const link = textElement('a', 'Open TicketSwap listing ↗');
      link.className = 'plain-act';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      details.append(link);
    }
  }

  details.append(textElement('h4', 'Ticket categories'));
  if (market.categories.length) {
    const categories = document.createElement('ul');
    for (const category of market.categories) {
      const label = category.title || 'Category unknown';
      const plus = entry.complete ? '' : '+';
      categories.append(textElement('li',
        `${label} · ${category.availableTickets}${plus} · ${priceRange(category.buyerPrices)}`));
    }
    details.append(categories);
  } else {
    details.append(textElement('p', 'No categories observed in the checked listings.'));
  }

  details.append(renderHistory(entry.marketHistory ?? []));
  return details;
}
