import test from 'node:test';
import assert from 'node:assert/strict';
import {preserveManualConcerts} from '../js/concert-search-model.js';
import {searchFestivalConcerts,searchIncludingFestivals} from './sources/manual-festival-search.mjs';
const url='https://www.festivalinfo.nl/festival/36695/Roadburn/2027/';
const event={ '@type':'Festival',url,name:'Roadburn',startDate:'2027-04-15',endDate:'2027-04-18',location:{name:'Roadburn',address:{addressLocality:'Tilburg',addressCountry:'NL'}},performer:[{name:'Neurosis'},{name:'Emma Ruth Rundle'}]};
const page=e=>`<script type="application/ld+json">${JSON.stringify(e)}</script>`;
const month=e=>page(e)+'<a href="/festivals/?type_select=maand&maand=05&jaar=2027">Next</a>';
const req=(artist='Roadburn',place='')=>({id:'949df15a-284c-46c3-8b8e-3965dc7673f7',artist,place});
const options={startDate:'2027-04-01',endDate:'2027-04-30',pause:async()=>{}};
const run=(request,extra={})=>searchFestivalConcerts(request,{...options,fetcher:async u=>u===url?page(event):month(event),...extra});
test('Add finds a festival by name, optional Festival suffix and edition year',async()=>{
  for(const name of ['Roadburn','ROADBURN','Roadburn Festival','Roadburn 2027']) {
    const {concerts}=await run(req(name));assert.equal(concerts.length,1);
    const c=concerts[0];assert.equal(c.id,'rec-festivalinfo-36695');assert.equal(c.artist,'Roadburn');assert.equal(c.endDate,'2027-04-18');
    assert.deepEqual(c.supportingArtists,[]);assert.deepEqual(c.lineup,['Neurosis','Emma Ruth Rundle']);
  }
});
test('band search finds its confirmed festival bill without substring matches',async()=>{
  const {concerts}=await run(req('Emma Ruth Rundle','Netherlands'));
  assert.equal(concerts.length,1);assert.deepEqual(concerts[0].matchedArtists,['Emma Ruth Rundle']);
  assert.equal((await run(req('Neuro'))).concerts.length,0);
  assert.equal((await run(req('Road'))).concerts.length,0);
});
test('country, city, worldwide and wrong-country filters remain explicit',async()=>{
  assert.equal((await run(req('Roadburn','Tilburg'))).concerts.length,1);
  assert.equal((await run(req('Roadburn','Netherlands'))).concerts.length,1);
  assert.equal((await run(req('Roadburn','Belgium'))).concerts.length,0);
  assert.equal((await run(req('Roadburn','Amsterdam'))).concerts.length,0);
  const be={...event,location:{name:'Roadburn',address:{addressLocality:'Antwerpen',addressCountry:'BE'}}};
  assert.equal((await run(req('Roadburn'),{fetcher:async u=>u===url?page(be):month(be)})).concerts.length,1);
});
test('location-only search uses saved listening and excludes unrelated lineups',async()=>{
  assert.equal((await run(req('','Tilburg'),{identity:{artistCounts:{overall:{neurosis:25}}}})).concerts.length,1);
  assert.equal((await run(req('','Tilburg'),{identity:{artistCounts:{overall:{Tool:25}}}})).concerts.length,0);
});
test('edition own page, cancellation and date changes override the index',async()=>{
  assert.equal((await run(req(),{fetcher:async u=>u===url?page({...event,eventStatus:'https://schema.org/EventCancelled'}):month(event)})).concerts.length,0);
  assert.equal((await run(req(),{fetcher:async u=>u===url?page({...event,startDate:'2027-06-15',endDate:'2027-06-18'}):month(event)})).concerts.length,0);
});
test('deadline bounds festival requests and returns coverage warning',async()=>{
  let calls=0;const r=await run(req(),{deadline:1,clock:()=>2,fetcher:async()=>{calls++;throw Error('must not fetch');}});
  assert.equal(calls,0);assert.equal(r.coverage.unavailable,true);assert.ok(r.warnings.length);
});
test('named festival lookup uses cached monthly index but still verifies the edition',async()=>{
  const cache={};await run(req('Neurosis'),{festivalCache:cache,now:1e12});
  let calls=0;const r=await run(req('Roadburn'),{festivalCache:cache,now:1e12+1,fetcher:async()=>{calls++;throw Error('must not fetch');}});
  assert.equal(r.concerts.length,1);assert.equal(calls,0);
});
test('concert and festival searches run concurrently and combine distinct results',async()=>{
  let concertStarted=false,festivalStarted=false;
  const r=await searchIncludingFestivals(req(),options,{
    concerts:async()=>{concertStarted=true;await Promise.resolve();assert.ok(festivalStarted);return {concerts:[{id:'concert',artist:'Neurosis',date:'2027-04-01'}],coverage:{unavailable:false}};},
    festivals:async()=>{festivalStarted=true;assert.ok(concertStarted);return {concerts:[{id:'festival',artist:'Roadburn',date:'2027-04-15'}],coverage:{unavailable:false}};}
  });
  assert.deepEqual(r.concerts.map(c=>c.id),['concert','festival']);assert.equal(r.coverage.unavailable,false);
});
test('one source failure keeps the other results, with a clear warning',async()=>{
  const r=await searchIncludingFestivals(req(),options,{concerts:async()=>{throw Error('outage');},festivals:async()=>({concerts:[{id:'festival',date:'2027-04-15'}],coverage:{unavailable:false}})});
  assert.equal(r.concerts.length,1);assert.equal(r.coverage.unavailable,false);assert.ok(r.warnings.length);
  await assert.rejects(searchIncludingFestivals(req(),options,{concerts:async()=>{throw Error();},festivals:async()=>{throw Error();}}));
});
test('same edition has the same identity for automatic and manual discovery; results deduplicate',async()=>{
  const c=(await run(req())).concerts[0];const result={concerts:[c],coverage:{unavailable:false}};
  const r=await searchIncludingFestivals(req(),options,{concerts:async()=>result,festivals:async()=>result});
  assert.equal(r.concerts.length,1);assert.equal(c.sourceId,'36695');assert.equal(c.id,'rec-festivalinfo-36695');
});

test('manually added festival survives discovery until its final day',async()=>{
  const c={...(await run(req())).concerts[0],manualSearch:{artist:'Roadburn'}};
  assert.equal(preserveManualConcerts([],[c],{today:'2027-04-17',history:{}}).length,1);
  assert.equal(preserveManualConcerts([],[c],{today:'2027-04-19',history:{}}).length,0);
});
