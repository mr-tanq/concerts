import test from 'node:test';
import assert from 'node:assert/strict';
import { officialTicketSources, parseOfficialTicketPage } from './sources/official-ticket-providers.mjs';
const concert={artist:'Example Act',date:'2027-03-10',venue:'Muziekgieterij',city:'Maastricht',country:'NL',ticketUrl:'https://muziekgieterij.stager.co/shop/concert/events/123?eventId=123&utm_source=test'};
test('direct Stager candidate retains identity parameters and is first',()=>{
 const [source]=officialTicketSources(concert);
 assert.equal(source.provider,'stager-jsonld');
 assert.equal(source.url,'https://muziekgieterij.stager.co/shop/concert/events/123?eventId=123');
});
test('unreviewed intermediary is not treated as official seller',()=>{
 const sources=officialTicketSources({...concert,ticketUrl:'https://www.podiuminfo.nl/ticket/123/cd/example/'});
 assert.ok(!sources.some(s=>s.domain==='podiuminfo.nl'));
});
test('direct structured offer still requires matching event',()=>{
 const [source]=officialTicketSources(concert);
 const event={'@type':'MusicEvent',name:concert.artist,startDate:concert.date,location:{name:concert.venue,address:{addressLocality:concert.city,addressCountry:'NL'}},offers:{'@type':'Offer',price:30,priceCurrency:'EUR',availability:'https://schema.org/InStock'}};
 const html=e=>'<script type="application/ld+json">'+JSON.stringify(e)+'</script>';
 const [offer]=parseOfficialTicketPage(html(event),concert,source,Date.parse('2026-11-26'));
 assert.equal(offer.listedCents,3000);
 assert.equal(offer.finalCents,null);
 assert.deepEqual(parseOfficialTicketPage(html({...event,startDate:'2027-03-11'}),concert,source,Date.parse('2026-11-26')),[]);
});
