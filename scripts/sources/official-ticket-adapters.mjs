// official-ticket-adapters.mjs
//
// Provider-specific readers for official venue pages whose prices are not in
// schema.org Offer data. Each adapter was written against the public markup
// observed in the 2026-11-26 live audit (docs/DIRECT_TICKET_AUDIT.md) and
// only reads what the page states explicitly:
//
//   013            Entree price table + "Incl. servicekosten", tickets.013.nl
//   Doornroosje    price on the ticket button, ticketshop.doornroosje.nl
//   AFAS Live      per-date category list, "Alle prijzen zijn inclusief
//                  servicekosten", Ticketmaster event link
//   Paradiso       the page's own event record (also Parallel): base price,
//                  service fee, sold-out / waiting-list state, shop URL
//   Ziggo Dome     public agenda API: ticket categories, showState, seller
//
// Identity is never taken from these blocks alone: the caller has already
// matched the page (host owned by the venue, artist and date via the shared
// schedule parser), and each adapter re-checks the date it reads.
//
// Final all-in prices stay null: no adapter can see checkout-only charges
// (transaction or handling fees), so "incl. servicekosten" is recorded as
// context on the published price, not as a verified buyer total.

import * as cheerio from 'cheerio';
import { classifyTicketLink } from '../../js/ticket-links.js';
import { namedDate } from './manual-concert-search.mjs';
import { pickSeller, sellerLinksOnPage, buttonState } from './official-ticket-sellers.mjs';

export const euroCents = text => {
  const match = /€\s*(\d{1,4})(?:[,.](\d{2}))?(?!\d)/.exec(String(text ?? ''));
  return match ? Number(match[1]) * 100 + Number(match[2] ?? 0) : null;
};

function offer(source, observedAt, fields) {
  return {
    seller: fields.seller, category: fields.category || 'Category not stated',
    sourceUrl: source.pageUrl ?? source.url, purchaseUrl: fields.purchaseUrl ?? source.pageUrl ?? source.url,
    provider: fields.provider, offerKey: fields.offerKey ?? null,
    verifiedAt: new Date(observedAt).toISOString(), evidence: fields.evidence,
    quantity: 1, availability: fields.availability ?? 'unknown', currency: 'EUR', faceCents: null,
    listedCents: fields.listedCents ?? null, baseCents: fields.baseCents ?? null,
    feesCents: fields.feesCents ?? null, finalCents: null, feeInclusive: false,
    ...(fields.priceContext ? { priceContext: fields.priceContext } : {}),
    resaleEventId: null, resaleTypeId: null, equivalenceEvidence: null
  };
}

const stateAvailability = state => state === 'sold-out' || state === 'waitlist' ? 'sold-out' : 'unknown';

function venueSeller(html, url) {
  const links = sellerLinksOnPage(html, url);
  return { links, seller: pickSeller(links) };
}

// 013: <ul class="specs_table"><li><b>Entree</b> … <ul class="price_table"><li><b>€ 42,30</b><span>label</span>
function adapter013(html, concert, source, observedAt) {
  const $ = cheerio.load(html);
  const { seller } = venueSeller(html, source.url);
  const entry = $('ul.specs_table > li').filter((_, node) => $(node).children('b').first().text().trim() === 'Entree');
  if (entry.length !== 1) return [];
  const date = $('ul.specs_table > li').filter((_, node) => $(node).children('b').first().text().trim() === 'Datum')
    .find('span').first().text();
  const day = /(\d{1,2}) (\w+) '(\d{2})/.exec(date.replace(/&#0?39;|’/g, "'"));
  if (!day || namedDate(`${day[1]} ${day[2]} 20${day[3]}`) !== concert.date) return [];
  const included = /^incl\. servicekosten$/i.test(entry.find('small').first().text().trim());
  return entry.find('ul.price_table > li').toArray().slice(0, 12).map(row => {
    const label = $(row).find('div span').first().text().replace(/\s+/g, ' ').trim();
    return { label, cents: euroCents($(row).children('b').first().text()) };
  }).filter(row => row.cents !== null).map(row => offer(source, observedAt, {
    seller: '013', category: row.label, provider: '013-event-page',
    purchaseUrl: seller?.url, listedCents: row.cents, availability: stateAvailability(seller?.state),
    evidence: 'Official 013 event page price table',
    priceContext: included ? { serviceFeesIncluded: true } : null
  }));
}

// Doornroosje: <div class="js-order-button"><a href="https://ticketshop…"><span class="c-btn__price">€ 31,00</span> Tickets</a>
function adapterDoornroosje(html, concert, source, observedAt) {
  const $ = cheerio.load(html);
  const buttons = $('.js-order-button a[href]');
  if (buttons.length !== 1) return [];
  const link = classifyTicketLink(buttons.attr('href'), source.url);
  if (link.kind !== 'official-seller') return [];
  const listedCents = euroCents(buttons.find('.c-btn__price').text());
  const state = buttonState(buttons.text());
  if (listedCents === null && !state) return [];
  return [offer(source, observedAt, {
    seller: 'Doornroosje', provider: 'doornroosje-event-page', purchaseUrl: link.url,
    listedCents, availability: stateAvailability(state), evidence: 'Official Doornroosje ticket button price'
  })];
}

// AFAS Live: <details><date>woensdag, 24 maart 2027</date> … <ul><li>General Admission<span>€ 100,98</span></li>
function adapterAfasLive(html, concert, source, observedAt) {
  const $ = cheerio.load(html);
  const blocks = $('.dates details').filter((_, node) =>
    namedDate($(node).find('summary .desktop date').first().text().replace(',', '')) === concert.date);
  if (blocks.length !== 1) return [];
  const block = blocks.first();
  const button = block.find('a.button.first[href]');
  const link = button.length === 1 ? classifyTicketLink(button.attr('href'), source.url) : null;
  const included = /alle prijzen zijn inclusief servicekosten/i.test(block.find('.ticket').text());
  return block.find('ul > li').toArray().slice(0, 12).map(row => {
    const price = $(row).children('span').first();
    const label = $(row).clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    return { label, cents: euroCents(price.text()) };
  }).filter(row => row.cents !== null && row.label && !/premium|vip/i.test(row.label)).map(row => offer(source, observedAt, {
    seller: 'Ticketmaster', category: row.label, provider: 'afaslive-event-page',
    purchaseUrl: link?.kind === 'official-seller' ? link.url : null, listedCents: row.cents,
    availability: stateAvailability(buttonState(button.text())),
    evidence: 'Official AFAS Live ticket categories', priceContext: included ? { serviceFeesIncluded: true } : null
  }));
}

// Paradiso and Parallel embed the page's event record in the framework
// payload. The record is located by this page's own `uri`.
function adapterParadiso(html, concert, source, observedAt) {
  const path = new URL(source.url).pathname.replace(/^\/(?:nl|en)\//, '/').replace(/^\/|\/$/g, '');
  const text = html.replace(/\\"/g, '"');
  const start = text.indexOf(`"uri":"${path}"`);
  if (start < 0) return [];
  const end = text.indexOf('"uri":"', start + 7);
  const record = text.slice(start, end < 0 ? start + 20000 : end);
  const field = name => {
    const match = new RegExp(`"${name}":(null|"([^"]{0,300})")`).exec(record);
    return match && match[1] !== 'null' ? match[2] : null;
  };
  const cents = value => /^\d{1,6}$/.test(value ?? '') ? Number(value) : null;
  const shop = classifyTicketLink(field('ticketUrl'));
  if (shop.kind !== 'official-seller') return [];
  const baseCents = cents(field('ticketPriceInCents'));
  const feesCents = cents(field('serviceFeeInCents'));
  const startingFrom = /"priceStartingFrom":true/.test(record);
  const soldOut = field('soldOut');
  const status = field('eventStatus');
  const availability = status === 'confirmed' && soldOut === 'no' ? 'available'
    : (soldOut && soldOut !== 'no') || field('waitingListUrl') ? 'sold-out' : 'unknown';
  if (baseCents === null && availability === 'unknown') return [];
  const membership = field('membership');
  return [offer(source, observedAt, {
    seller: shop.label, provider: 'paradiso-event-data', purchaseUrl: shop.url,
    category: startingFrom ? 'Lowest advertised ticket' : 'Ticket',
    baseCents: startingFrom ? null : baseCents, feesCents: startingFrom ? null : feesCents,
    listedCents: startingFrom || baseCents === null ? null : baseCents + (feesCents ?? 0),
    availability, evidence: 'Official event record on the venue page',
    priceContext: {
      ...(feesCents !== null && !startingFrom ? { serviceFeesIncluded: true } : {}),
      ...(membership && membership !== 'inapplicable' ? { membership } : {})
    }
  })];
}

// Ziggo Dome public agenda API (the event page itself is client-rendered).
export function parseZiggoTickets(payload, concert, source, observedAt) {
  const rows = payload?.data;
  if (!Array.isArray(rows) || rows.length !== 1) return [];
  const event = rows[0];
  if (String(event.showDate).slice(0, 10) !== concert.date) return [];
  const sales = classifyTicketLink(event.salesUrl);
  const seller = typeof event.event?.seller === 'string' ? event.event.seller.trim().slice(0, 60) : '';
  const availability = event.showState === 'OnSale' ? 'available'
    : /^sold ?out$/i.test(event.showState ?? '') ? 'sold-out' : 'unknown';
  const tickets = Array.isArray(event.tickets?.tickets) ? event.tickets.tickets.slice(0, 12) : [];
  return tickets.map(ticket => {
    const price = typeof ticket.ticketPrice === 'number' && Number.isFinite(ticket.ticketPrice)
      ? Math.round(ticket.ticketPrice * 100) : null;
    return { category: String(ticket.description ?? '').trim().slice(0, 140), price, id: ticket.ticketId };
  }).filter(ticket => ticket.price !== null && !/vip|premium|comfort|parking|parkeer/i.test(ticket.category))
    .map(ticket => offer(source, observedAt, {
      seller: seller || 'Ziggo Dome', category: ticket.category, provider: 'ziggodome-api',
      offerKey: typeof ticket.id === 'string' ? ticket.id.slice(0, 100) : null,
      purchaseUrl: sales.kind === 'official-seller' ? sales.url : null,
      listedCents: ticket.price, availability, evidence: 'Ziggo Dome public event data',
      priceContext: { serviceFeesIncluded: true }
    }));
}

const ADAPTERS = {
  '013.nl': adapter013,
  'doornroosje.nl': adapterDoornroosje,
  'afaslive.nl': adapterAfasLive,
  'paradiso.nl': adapterParadiso
};

export function venuePageOffers(html, concert, source, observedAt) {
  const adapter = ADAPTERS[source.domain];
  return adapter ? adapter(html, concert, source, observedAt) : [];
}
