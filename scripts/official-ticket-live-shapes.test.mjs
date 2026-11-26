import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficialTicketPage } from './sources/official-ticket-providers.mjs';

const stamp = Date.parse('2026-11-26T19:56:00Z');
const concert = { artist: 'Example Act', date: '2027-02-20', country: 'NL' };
function structured(location, offer, content = '') {
  return `<main>${content}</main><script type="application/ld+json">${JSON.stringify({
    '@type': 'MusicEvent', name: concert.artist, startDate: concert.date, location, offers: offer
  })}</script>`;
}

test('TivoliVredenburg admits its observed address, offer type, checkout and service-fee formats', () => {
  const domain = 'tivolivredenburg.nl';
  const c = { ...concert, venue: 'TivoliVredenburg', city: 'Utrecht' };
  const source = { domain, provider: 'venue-jsonld', label: domain, url: 'https://www.tivolivredenburg.nl/agenda/example/' };
  const url = 'https://ticket.tivolivredenburg.nl/nl/buyingflow/tickets/100/200';
  const format = {
    '@type': 'offer', priceCurrency: 'EUR', price: '34.5', availability: 'http://schema.org/InStock', url
  };
  const page = structured({ name: c.venue, address: 'Vredenburgkade 11, Utrecht, NL' }, format,
    `<div class="btn-group"><p class="btn-group__price">€ 34,50</p><a class="btn-group__link" href="${url}">Bestel tickets</a></div><p class="btn-group__info">incl. servicekosten</p>`);
  const [offer] = parseOfficialTicketPage(page, c, source, stamp);
  assert.equal(offer.availability, 'available');
  assert.equal(offer.listedCents, 3450);
  assert.equal(offer.finalCents, null);
  assert.equal(offer.category, 'Category not stated');
  assert.deepEqual(offer.priceContext, { serviceFeesIncluded: true });
  assert.deepEqual(parseOfficialTicketPage(page.replace('Utrecht, NL', 'Amsterdam, NL'), c, source, stamp), []);
  assert.deepEqual(parseOfficialTicketPage(page.replaceAll('ticket.tivolivredenburg.nl', 'ticket.tivolivredenburg.nl.example.invalid'), c, source, stamp), []);
});

test('Paradiso ties a membership exclusion to the observed price and checkout block', () => {
  const domain = 'paradiso.nl';
  const c = { ...concert, venue: 'Paradiso', city: 'Amsterdam' };
  const source = { domain, provider: 'venue-jsonld', label: domain, url: 'https://www.paradiso.nl/programma/example/123' };
  const url = 'https://tickets.paradiso.nl/123456abcdef123456abcdef';
  const format = { '@type': 'Offer', priceCurrency: 'EUR', price: 55.4, availability: 'https://schema.org/SoldOut', url };
  const page = structured({ name: c.venue, address: { addressLocality: c.city, addressCountry: 'NL' } },
    format, `<div><a href="${url}">WachtlijstTicket € 55,40</a><div><p>Exclusief € 4,50 maandlidmaatschap</p></div></div>`);
  const [offer] = parseOfficialTicketPage(page, c, source, stamp);
  assert.equal(offer.availability, 'sold-out');
  assert.equal(offer.listedCents, 5540);
  assert.equal(offer.feesCents, null);
  assert.equal(offer.finalCents, null);
  assert.deepEqual(offer.priceContext, { excludedMembershipCents: 450 });
  assert.equal(parseOfficialTicketPage(page.replace('55,40', '77,00'), c, source, stamp)[0].priceContext, undefined);
});

test('Patronaat scoped event panel verifies advertised price only, never availability from a link', () => {
  const domain = 'patronaat.nl';
  const c = { ...concert, venue: 'Patronaat', city: 'Haarlem', supportingArtists: ['Support Act'] };
  const source = { domain, provider: 'venue-jsonld', label: domain, url: 'https://patronaat.nl/event/example/' };
  const page = `<link rel="canonical" href="${source.url}"><h1 class="event__name">Example Act + Support Act</h1>
    <div class="event__info-bar"><div class="event__info-bar--star-date">za 20 feb 2027</div>
    <div class="event__info-bar--ticket-price">€ 30,50</div>
    <div class="event__ticket-button"><a class="button--tickets" href="https://www.ticketmaster.nl/event/123">Tickets</a></div></div>`;
  const [offer] = parseOfficialTicketPage(page, c, source, stamp);
  assert.equal(offer.listedCents, 3050);
  assert.equal(offer.availability, 'unknown');
  assert.equal(offer.purchaseUrl, 'https://www.ticketmaster.nl/event/123');
  assert.equal(offer.finalCents, null);
  assert.deepEqual(parseOfficialTicketPage(page.replace('20 feb', '21 feb'), c, source, stamp), []);
  assert.deepEqual(parseOfficialTicketPage(page.replace('Support Act', 'Wrong Act'), c, source, stamp), []);
});
