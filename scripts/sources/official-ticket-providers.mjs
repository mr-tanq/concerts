import * as cheerio from 'cheerio';
import { searchKey } from '../../js/concert-search-model.js';
import { countryCode, locationKey } from '../../js/concert-countries.js';
import { localDate, validDate } from '../../js/concert-schedule.js';
import { ticketSourceURL } from '../../js/ticket-official.js';
import { venueConfig, zoneFor } from './concert-schedule.mjs';
import { namedDate } from './manual-concert-search.mjs';
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

function matchesEvent(event, concert, source) {
  if (event.eventStatus && schemaName(event.eventStatus) !== 'EventScheduled') return false;
  const date = typeof event.startDate === 'string' ? event.startDate : '';
  const day = /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(date)
    ? (Number.isFinite(Date.parse(date)) ? localDate(Date.parse(date), zoneFor(concert)) : '')
    : date.slice(0, 10);
  const location = event.location;
  const address = source.domain === 'tivolivredenburg.nl' && typeof location?.address === 'string'
    ? location.address.split(',').map(part => part.trim()) : [];
  const city = location?.address?.addressLocality ?? (address.length >= 3 ? address.at(-2) : null);
  const country = location?.address?.addressCountry ?? (address.length >= 3 ? address.at(-1) : null);
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
  const events = structuredEvents(html);
  const matches = events.filter(event => matchesEvent(event, concert, source));
  if (!events.length && source.domain === 'patronaat.nl') {
    const offer = patronaatOffer(html, concert, source, observedAt);
    return offer ? [offer] : [];
  }
  if (matches.length !== 1) return [];
  const result = [];
  for (const offer of asArray(matches[0].offers)) {
    const typedOffer = hasType(offer, 'Offer')
      || (source.domain === 'tivolivredenburg.nl' && hasType(offer, 'offer'));
    if (!typedOffer || offer.eligibleCustomerType) continue;
    if ((offer.validFrom && !(Date.parse(offer.validFrom) <= observedAt))
      || (offer.validThrough && !(Date.parse(offer.validThrough) >= observedAt))) continue;
    const category = typeof offer.name === 'string' ? offer.name.trim() : '';
    if (/\b(resale|doorverkoop|parking|upgrade|afterparty|locker|shuttle|vip)\b/i.test(category)) continue;
    const purchase = sourceURL(offer.url, source.url);
    const knownStagerLink = purchase && /^[a-z0-9-]+\.stager\.co$/.test(host(purchase))
      && new URL(purchase).pathname.startsWith('/shop/') && purchase === sourceURL(concert.ticketUrl);
    if (purchase && host(purchase) !== source.domain && !isTicketmaster(purchase) && !knownStagerLink && !venueCheckout(source.domain, purchase)) continue;
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
  if (result.length === 1) {
    const priceContext = venuePriceContext(html, source.domain, result[0]);
    if (priceContext) result[0].priceContext = priceContext;
  }
  return result;
}

function venueCheckout(domain, purchase) {
  const url = new URL(purchase);
  if (domain === 'tivolivredenburg.nl') return url.hostname === 'ticket.tivolivredenburg.nl'
    && /^\/nl\/buyingflow\/tickets\/\d+\/\d+\/?$/.test(url.pathname);
  if (domain === 'paradiso.nl') return url.hostname === 'tickets.paradiso.nl'
    && /^\/[a-z0-9]{12,64}\/?$/i.test(url.pathname);
  return false;
}

function dutchEUR(value) {
  const amount = /^€\s*(\d+),(\d{2})$/.exec(value.trim());
  return amount ? minorUnits(amount[1] + '.' + amount[2], 'EUR') : null;
}

function venuePriceContext(html, domain, offer) {
  if (!['tivolivredenburg.nl', 'paradiso.nl'].includes(domain) || offer.listedCents === null) return null;
  const $ = cheerio.load(html);
  if (domain === 'tivolivredenburg.nl') {
    const matching = $('main .btn-group__link').filter((_, link) => {
      const group = $(link).closest('.btn-group');
      return sourceURL($(link).attr('href'), offer.sourceUrl) === offer.purchaseUrl
        && dutchEUR(group.find('.btn-group__price').text()) === offer.listedCents
        && /^incl\. servicekosten$/i.test(group.next('.btn-group__info').text().trim());
    });
    return matching.length ? { serviceFeesIncluded: true } : null;
  }

  const notes = new Set();
  $('main p').each((_, node) => {
    const membership = /^Exclusief\s+(€\s*\d+,\d{2})\s+maandlidmaatschap$/i.exec($(node).text().trim());
    if (!membership) return;
    const related = $(node).parent().parent().find('a[href]').toArray().some(link => {
      const url = sourceURL($(link).attr('href'), offer.sourceUrl);
      const price = /€\s*\d+,\d{2}\s*$/.exec($(link).text().trim());
      return url && venueCheckout(domain, url) && price && dutchEUR(price[0]) === offer.listedCents;
    });
    if (related) notes.add(dutchEUR(membership[1]));
  });
  return notes.size === 1 ? { excludedMembershipCents: [...notes][0] } : null;
}

function patronaatOffer(html, concert, source, observedAt) {
  if (venueKey(concert.venue) !== 'patronaat' || locationKey(concert.city) !== 'haarlem'
    || countryCode(concert.country) !== 'NL' || !/^\/event\/[^/]+\/?$/.test(new URL(source.url).pathname)) return null;
  const $ = cheerio.load(html);
  const canonical = sourceURL($('link[rel="canonical"]').attr('href'), source.url);
  const headline = $('h1.event__name');
  const card = $('.event__info-bar');
  if (canonical !== source.url || headline.length !== 1 || card.length !== 1) return null;
  const billing = headline.text().trim().split(/\s+\+\s+/).map(searchKey);
  const expected = [concert.artist, ...asArray(concert.supportingArtists)].map(searchKey);
  if (searchKey(headline.text()) !== searchKey(concert.eventName) && billing.join('|') !== expected.join('|')) return null;
  const date = card.find('.event__info-bar--star-date');
  const price = card.find('.event__info-bar--ticket-price');
  if (date.length !== 1 || price.length !== 1 || namedDate(date.text()) !== concert.date) return null;
  const listedCents = dutchEUR(price.text());
  if (listedCents === null) return null;

  const links = card.find('.event__ticket-button a.button--tickets');
  const purchase = links.length === 1 ? sourceURL(links.attr('href'), source.url) : null;
  return {
    seller: 'Patronaat (official source)', category: 'Category not stated', provider: 'patronaat-event-page',
    sourceUrl: source.url, purchaseUrl: purchase && isTicketmaster(purchase) ? purchase : source.url,
    verifiedAt: new Date(observedAt).toISOString(), evidence: 'Official Patronaat event price',
    quantity: 1, availability: 'unknown', currency: 'EUR', faceCents: null,
    listedCents, baseCents: null, feesCents: null, finalCents: null, feeInclusive: false,
    offerKey: null, resaleEventId: null, resaleTypeId: null, equivalenceEvidence: null
  };
}
