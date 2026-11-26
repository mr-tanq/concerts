import * as cheerio from 'cheerio';
import { searchKey } from '../../js/concert-search-model.js';
import { countryCode, locationKey } from '../../js/concert-countries.js';
import { localDate, validDate } from '../../js/concert-schedule.js';
import { ticketSourceURL } from '../../js/ticket-official.js';
import { venueConfig, zoneFor } from './concert-schedule.mjs';
import { publisherConfigs, venueKey } from './schedule-providers.mjs';

const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];
const schemaName = value => typeof value === 'string'
  ? value.replace(/^https?:\/\/schema\.org\//, '') : '';
const hasType = (value, type) => asArray(value?.['@type']).some(item => schemaName(item) === type);
const host = url => new URL(url).hostname.replace(/^www\./, '');
const isTicketmaster = url => /^(ticketmaster\.nl|ticketmaster\.be)$/.test(host(url))
  && /^\/(?:[a-z]{2}\/)?event\/[^/]+/.test(new URL(url).pathname);

function sourceURL(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const safe = ticketSourceURL(new URL(value, base).href);
    if (!safe) return null;
    const url = new URL(safe);
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

export function officialTicketSources(concert) {
  const publishers = publisherConfigs(concert, venueConfig(concert));
  const candidates = new Map();
  for (const input of [
    concert.officialEventUrl, concert.officialUrl,
    ...asArray(concert.schedule?.sources).filter(source => source?.kind === 'official').map(source => source.url),
    ...asArray(concert.scheduleSourceUrls), concert.sourceUrl, concert.ticketUrl
  ]) {
    const url = sourceURL(input);
    if (!url || candidates.has(url)) continue;
    const domain = host(url);
    const publisher = publishers.find(item => item[1] === domain);
    const path = new URL(url).pathname.replace(/\/$/, '');
    if (isTicketmaster(url)) {
      candidates.set(url, { url, domain, provider: 'ticketmaster-jsonld', label: 'Ticketmaster' });
    } else if (publisher && path && path !== publisher[2].replace(/\/$/, '')) {
      candidates.set(url, { url, domain, provider: 'venue-jsonld', label: domain });
    }
  }
  // Reserve a slot for a known direct seller as well as the strongest existing venue page.
  const sources = [...candidates.values()];
  return [
    ...sources.filter(source => source.provider === 'venue-jsonld').slice(0, 2),
    ...sources.filter(source => source.provider === 'ticketmaster-jsonld').slice(0, 1)
  ];
}

function structuredEvents(html) {
  const $ = cheerio.load(html);
  const events = [];
  function collect(value) {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== 'object') return;
    if (hasType(value, 'Event') || hasType(value, 'MusicEvent')) events.push(value);
    for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item']) collect(value[key]);
  }
  $('script[type="application/ld+json"]').each((_, node) => {
    try { collect(JSON.parse($(node).text())); } catch {}
  });
  return events;
}

function matchesEvent(event, concert) {
  if (event.eventStatus && schemaName(event.eventStatus) !== 'EventScheduled') return false;
  const date = typeof event.startDate === 'string' ? event.startDate : '';
  const day = /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(date)
    ? (Number.isFinite(Date.parse(date)) ? localDate(Date.parse(date), zoneFor(concert)) : '')
    : date.slice(0, 10);
  const location = event.location;
  const city = location?.address?.addressLocality;
  const country = location?.address?.addressCountry;
  const billing = [concert.artist, concert.eventName].map(searchKey).filter(Boolean);
  const performers = asArray(event.performer).map(person => searchKey(person?.name ?? person));
  return validDate(day) && day === concert.date && !!location?.name && !!concert.venue
    && venueKey(location.name) === venueKey(concert.venue)
    && !!city && !!concert.city && locationKey(city) === locationKey(concert.city)
    && (!country || countryCode(country?.name ?? country) === countryCode(concert.country))
    && (billing.includes(searchKey(event.name)) || (!!searchKey(concert.artist) && performers.includes(searchKey(concert.artist))))
    && !/\b(tribute|parking|upgrade|afterparty|locker|shuttle|resale)\b/i.test(event.name || '');
}

const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));
function minorUnits(value, currency) {
  if (!supportedCurrencies.has(currency) || !['string', 'number'].includes(typeof value)) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return null;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if ((match[2]?.length ?? 0) > digits) return null;
  const amount = Number(match[1]) * 10 ** digits + Number((match[2] ?? '').padEnd(digits, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}

const labels = {
  baseCents: new Set(['ticket price excluding fees', 'ticketprijs exclusief kosten', 'ticketprijs exclusief servicekosten']),
  feesCents: new Set(['booking fee', 'booking fees', 'boekingskosten', 'servicekosten']),
  finalCents: new Set(['total price including all fees', 'totaalprijs inclusief alle kosten'])
};

function pricesFor(offer, currency) {
  const specifications = asArray(offer.priceSpecification)
    .filter(spec => hasType(spec, 'UnitPriceSpecification') && spec.priceCurrency === currency);
  const explicitlySingle = quantity => hasType(quantity, 'QuantitativeValue')
    && (quantity.value === 1 || (quantity.minValue === 1 && quantity.maxValue === 1))
    && (quantity.maxValue === undefined || quantity.maxValue === 1)
    && (quantity.minValue === undefined || quantity.minValue === 1);
  const amounts = {};
  for (const [field, allowed] of Object.entries(labels)) {
    const matching = specifications.filter(spec => allowed.has(searchKey(spec.name)));
    amounts[field] = matching.length === 1
      && (field !== 'finalCents' || explicitlySingle(matching[0].eligibleQuantity ?? offer.eligibleQuantity))
      ? minorUnits(matching[0].price, currency) : null;
  }

  const { baseCents, feesCents, finalCents } = amounts;
  if (finalCents !== null && ((baseCents !== null && finalCents < baseCents)
    || (feesCents !== null && finalCents < feesCents)
    || (baseCents !== null && feesCents !== null && baseCents + feesCents !== finalCents))) {
    amounts.finalCents = null;
  }
  return { ...amounts, listedCents: minorUnits(offer.price, currency), feeInclusive: amounts.finalCents !== null };
}

export function parseOfficialTicketPage(html, concert, source, observedAt) {
  const matches = structuredEvents(html).filter(event => matchesEvent(event, concert));
  if (matches.length !== 1) return [];
  const result = [];
  for (const offer of asArray(matches[0].offers)) {
    if (!hasType(offer, 'Offer') || offer.eligibleCustomerType) continue;
    if ((offer.validFrom && !(Date.parse(offer.validFrom) <= observedAt))
      || (offer.validThrough && !(Date.parse(offer.validThrough) >= observedAt))) continue;
    const category = typeof offer.name === 'string' ? offer.name.trim() : '';
    if (/\b(resale|doorverkoop|parking|upgrade|afterparty|locker|shuttle|vip)\b/i.test(category)) continue;
    const purchase = sourceURL(offer.url, source.url);
    const knownStagerLink = purchase && /^[a-z0-9-]+\.stager\.co$/.test(host(purchase))
      && new URL(purchase).pathname.startsWith('/shop/') && purchase === sourceURL(concert.ticketUrl);
    if (purchase && host(purchase) !== source.domain && !isTicketmaster(purchase) && !knownStagerLink) continue;
    if (source.provider === 'ticketmaster-jsonld'
      && !/^(standard tickets?|reguliere? tickets?|standaard tickets?)$/i.test(category)) continue;
    const currencies = new Set(asArray(offer.priceSpecification).map(spec => spec?.priceCurrency).filter(Boolean));
    const currency = offer.priceCurrency ?? (currencies.size === 1 ? [...currencies][0] : null);
    const verifiedCurrency = supportedCurrencies.has(currency) ? currency : null;
    const availability = schemaName(offer.availability);
    const verifiedAvailability = availability === 'InStock' ? 'available'
      : ['SoldOut', 'OutOfStock'].includes(availability) ? 'sold-out' : 'unknown';
    const prices = pricesFor(offer, verifiedCurrency);
    if (offer.priceValidUntil && !(Date.parse(offer.priceValidUntil) >= observedAt)) {
      for (const field of ['listedCents', 'baseCents', 'feesCents', 'finalCents']) prices[field] = null;
      prices.feeInclusive = false;
    }
    if (verifiedAvailability === 'unknown'
      && [prices.listedCents, prices.baseCents, prices.feesCents, prices.finalCents].every(value => value === null)) continue;
    const offerKey = typeof offer.sku === 'string' && offer.sku.trim().length <= 100 ? offer.sku.trim() : null;
    const seller = typeof offer.seller?.name === 'string' ? offer.seller.name.trim() : '';
    if (/\b(resale|doorverkoop)\b/i.test(seller)) continue;
    result.push({
      seller: seller.slice(0, 120) || (purchase && isTicketmaster(purchase) ? 'Ticketmaster' : source.label),
      category: category.slice(0, 140) || 'Category not stated',
      sourceUrl: source.url, purchaseUrl: purchase ?? source.url,
      provider: source.provider, offerKey,
      verifiedAt: new Date(observedAt).toISOString(),
      evidence: 'Official event page · structured offer data',
      quantity: 1, availability: verifiedAvailability, currency: verifiedCurrency, faceCents: null,
      ...prices, resaleEventId: null, resaleTypeId: null, equivalenceEvidence: null
    });
    if (result.length === 20) break;
  }
  return result;
}
