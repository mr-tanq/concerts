import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {concertSearchEnd} from '../js/concert-search-window.js';
import {parseOfficialEvents, searchConcerts, SEARCH_VENUES} from './sources/manual-concert-search.mjs';
import {matchesLocation, searchLocation} from '../js/concert-countries.js';
const config = JSON.parse(await readFile(new URL('../data/config.json',import.meta.url),'utf8'));
const venue = SEARCH_VENUES.find(v=>v[0]==='AFAS Live');
const url = 'https://www.afaslive.nl/agenda/bruce-dickinson';
const page = `<section class="agenda-item"><div class="floated"><h2>Bruce Dickinson<small>PsychoGod Tour</small></h2></div>
<ul class="act"><li>Special guests <a>Evergrey</a></li></ul>
<div class="floated dates"><details><summary><div class="desktop"><date>donderdag, 25 november 2027</date></div></summary>
<div><h3>Bruce Dickinson</h3><datetime>donderdag 25 november 2027</datetime><a class="button first" href="https://www.ticketmaster.nl/">tickets</a></div></details></div>
<div class="agendaInfo"><h2>Bruce Dickinson</h2></div></section>`;
const parse = (html=page, artist='Bruce Dickinson', eventURL=url) => parseOfficialEvents(html,eventURL,venue,artist);
test('automatic discovery and manual search share an 18-month configured horizon',()=>{
  assert.equal(concertSearchEnd('2026-10-29', config.discovery),'2028-04-29');
  assert.equal(concertSearchEnd('2026-10-29'),'2028-04-29');
});
test('month-end and leap-day dates clamp without rolling into the following month',()=>{
  assert.equal(concertSearchEnd('2026-08-31',{lookaheadMonths:18}),'2028-02-29');
  assert.equal(concertSearchEnd('2027-08-31',{lookaheadMonths:18}),'2029-02-28');
  assert.equal(concertSearchEnd('2028-02-29',{lookaheadMonths:12}),'2029-02-28');
  assert.throws(()=>concertSearchEnd('2026-02-30'));
  assert.throws(()=>concertSearchEnd('2026-10-29',{lookaheadMonths:-1}));
});
test('older day-based configurations still have their requested horizon',()=>{
  assert.equal(concertSearchEnd('2026-10-29',{lookaheadDays:365}),'2027-10-29');
});
test('AFAS HTML verifies event date, headliner and explicitly billed support',()=>{
  const [c]=parse();
  assert.equal(c.date,'2027-11-25');
  assert.equal(c.artist,'Bruce Dickinson');
  assert.deepEqual(c.lineup,['Bruce Dickinson','Evergrey']);
  assert.deepEqual(c.supportingArtists,['Evergrey']);
  assert.equal(c.city,'Amsterdam'); assert.equal(c.country,'NL');
  assert.equal(parse(page,'Evergrey').length,1);
  assert.equal(parse(page,'Iron Maiden').length,0);
});
test('AFAS rejects conflicting date, unrelated panel, cancelled event and foreign URL',()=>{
  assert.equal(parse(page.replace('donderdag, 25','donderdag, 26')).length,0);
  assert.equal(parse(page.replace('<h3>Bruce Dickinson','<h3>Other artist')).length,0);
  assert.equal(parse(page.replace('<date>','<date>Afgelast ')).length,0);
  assert.equal(parse(page,'Bruce Dickinson','https://example.com/agenda/bruce-dickinson').length,0);
  assert.equal(parse(page,'Bruce Dickinson','https://www.afaslive.nl/agenda').length,0);
});
test('search finds an announced show beyond one year and keeps range filtering and deduplication',async()=>{
  const run=endDate=>searchConcerts({id:'949df15a-284c-46c3-8b8e-3965dc7673f7',artist:'Bruce Dickinson',place:'AFAS Live'}, {
    dayCacheEntries:{}, startDate:'2026-10-29', endDate,
    officialFetcher:async target=>target===url ? page : `<a href="${url}">Bruce Dickinson</a><a href="${url}">Bruce Dickinson tickets</a>`,
    podiumFetcher:async()=>{throw new Error('No matching cached candidates');}
  });
  assert.equal((await run('2027-10-29')).concerts.length,0);
  const found=await run(concertSearchEnd('2026-10-29',config.discovery));
  assert.equal(found.concerts.length,1);
  assert.equal(found.concerts[0].date,'2027-11-25');
  assert.deepEqual(found.concerts[0].supportingArtists,['Evergrey']);
});
test('Belgian shows do not leak into a Netherlands-only search',()=>{
  const c={artist:'Manowar',country:'BE',city:'Antwerpen',venue:'AFAS Dome'};
  assert.equal(matchesLocation(c,searchLocation('Netherlands')),false);
  assert.equal(matchesLocation(c,searchLocation('Belgium')),true);
});
