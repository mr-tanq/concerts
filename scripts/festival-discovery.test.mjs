import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseFestivalEvents,festivalMonthKeys,festivalURL,discoverFestivals} from './sources/festivalinfo.mjs';
import {normalizeArtistName} from './sources/podiuminfo.mjs';
import {warmupArtists} from '../js/warmup-setlist-model.js';
const url='https://www.festivalinfo.nl/festival/36695/Roadburn/2027/';
const festival={ '@type':'Festival',url,name:'Roadburn',startDate:'2027-04-15',endDate:'2027-04-18',location:{name:'Roadburn',address:{addressLocality:'Tilburg',addressCountry:'NL'}},performer:[{name:'Neurosis'},{name:'Emma Ruth Rundle'},{name:'Neurosis'}]};
const html=(e=festival)=>`<script type="application/ld+json">${JSON.stringify(e)}</script>`;
const month=e=>html(e)+'<a href="/festivals/?type_select=maand&maand=05&jaar=2027">Next month</a>';
const options={trackedArtistNames:['Neurosis'],startDate:'2027-04-01',endDate:'2027-04-30',pause:async()=>{}};
test('festival parser preserves full period and deduplicates confirmed bands',()=>{
  const [e]=parseFestivalEvents(html(),url);
  assert.equal(e.concertId,'36695');assert.equal(e.festivalName,'Roadburn');
  assert.equal(e.date,'2027-04-15');assert.equal(e.endDate,'2027-04-18');assert.equal(e.country,'NL');
  assert.deepEqual(e.lineup,['Neurosis','Emma Ruth Rundle']);
});
test('artist links outside the confirmed bill never create a match',()=>{
  const page=html()+`<aside><a href="/artist/123/Tool/">Tool</a></aside><p>Similar to Tool</p><section id="grootte"><div class="confirmed_artist"><p>Trhä</p></div></section>`;
  assert.deepEqual(parseFestivalEvents(page,url)[0].lineup,['Neurosis','Emma Ruth Rundle','Trhä']);
});
test('invalid, ambiguous, foreign and cancelled festival metadata is rejected',()=>{
  for(const bad of [{startDate:'2027-02-30'},{endDate:'2027-04-14'},{endDate:'2027-08-01'},{url:'https://evil.test/festival/36695/Roadburn/2027/'},{location:[festival.location,festival.location]},{eventStatus:'https://schema.org/EventCancelled'},{eventStatus:'https://schema.org/EventPostponed'}])assert.deepEqual(parseFestivalEvents(html({...festival,...bad}),url),[]);
  assert.equal(festivalURL('http://www.festivalinfo.nl/festival/36695/Roadburn/2027/'),null);
  assert.deepEqual(parseFestivalEvents(html(),url.replace('36695','123')),[]);
});
test('month requests span years and the entire discovery window',()=>{
  assert.deepEqual(festivalMonthKeys('2026-12-31','2027-02-01'),['2026-12','2027-01','2027-02']);
  assert.equal(festivalMonthKeys('2026-10-31','2028-04-30').length,19);
});
test('month catalogue finds candidates; own page confirms lineup; cache avoids repeated fetches',async()=>{
  const cache={},requests=[];
  const fetcher=async u=>{requests.push(u);return u===url?html():month(festival);};
  const a=await discoverFestivals({...options,cache,fetcher,now:1e12});
  assert.equal(a.events.length,1);assert.deepEqual(a.events[0].matchedTracked,['Neurosis']);assert.equal(requests.length,2);
  const b=await discoverFestivals({...options,cache,fetcher,now:1e12+1000});
  assert.equal(b.events.length,1);assert.equal(requests.length,2);
});
test('detail page can disprove a catalogue match; names match exactly',async()=>{
  const noBand={...festival,performer:[{name:'Neurosis tribute'}]};
  assert.equal((await discoverFestivals({...options,cache:{},fetcher:async u=>u===url?html(noBand):month(festival)})).events.length,0);
});
test('unavailable source retains cached editions and reports degraded coverage',async()=>{
  const cache={};await discoverFestivals({...options,cache,now:1e12,fetcher:async u=>u===url?html():month(festival)});
  const result=await discoverFestivals({...options,cache,now:1e12+86400000,fetcher:async()=>{throw new Error('offline');}});
  assert.equal(result.events.length,1);assert.equal(result.stats.monthsStale,1);assert.equal(result.stats.editionsStale,1);
  const missing=await discoverFestivals({...options,cache:{},fetcher:async()=>'<html>challenge</html>'});
  assert.equal(missing.stats.monthsMissing,1);assert.equal(missing.events.length,0);
});
test('ignored month parameters are not cached as a successful empty month',async()=>{
  const cache={};const result=await discoverFestivals({...options,cache,fetcher:async()=>month(festival).replace('maand=05','maand=04')});
  assert.equal(result.stats.monthsMissing,1);assert.deepEqual(cache.months,{});
});
test('fresh cancellation removes a previously cached edition',async()=>{
  const cache={};await discoverFestivals({...options,cache,now:1e12,fetcher:async u=>u===url?html():month(festival)});
  const r=await discoverFestivals({...options,cache,now:1e12+86400000,fetcher:async u=>u===url?html({...festival,eventStatus:'https://schema.org/EventCancelled'}):month(festival)});
  assert.equal(r.events.length,0);assert.equal(cache.editions[url].event.cancelled,true);assert.equal(r.stats.editionsFailed,0);
});
test('overlapping editions remain discoverable until the last day; country rules still apply',async()=>{
  const run=extra=>discoverFestivals({...options,cache:{},fetcher:async u=>u===url?html():month(festival),...extra});
  assert.equal((await run({startDate:'2027-04-17'})).events.length,1);
  assert.equal((await run({startDate:'2027-04-19'})).events.length,0);
  assert.equal((await run({countries:['BE']})).events.length,0);
});
test('festivals use billed bands in Warm-up and not the festival title',()=>{
  assert.deepEqual(warmupArtists({isFestival:true,artist:'Roadburn',lineup:['Neurosis','Neurosis','Emma Ruth Rundle']}),['Neurosis','Emma Ruth Rundle']);
});
const source=await readFile(new URL('./discover-concerts.mjs',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('const slug ='),source.indexOf('// ---------- 3. Scoring'));
const ctx={normalizeArtistName};vm.createContext(ctx);vm.runInContext(helpers,ctx);
test('festival IDs cannot collide with concert IDs; handled editions remain excluded',()=>{
  assert.equal(ctx.makeRecId('36695'),'rec-podiuminfo-36695');
  assert.equal(ctx.makeRecId('36695','festivalinfo'),'rec-festivalinfo-36695');
  const event={...parseFestivalEvents(html(),url)[0],matchedTracked:['Neurosis']};
  assert.equal(ctx.isExcluded(event,new Set(['rec-festivalinfo-36695'])),true);
  assert.equal(ctx.isExcluded(event,new Set(['rec-podiuminfo-36695'])),false);
  assert.equal(ctx.alreadyInArchive(event,[{source:'festivalinfo',sourceId:'36695'}]),true);
  assert.equal(ctx.alreadyInArchive(event,[{source:'podiuminfo',sourceId:'36695'}]),false);
});
