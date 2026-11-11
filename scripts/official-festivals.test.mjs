import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  OFFICIAL_FESTIVAL_EDITIONS,parseOfficialFestival,discoverOfficialFestivals
} from './sources/official-festivals.mjs';
import {mergeOfficialFestivalEvents} from './lib/merge-official-festivals.mjs';
import {festivalLineupRevisit} from '../js/festival-revisit-model.js';

const road=OFFICIAL_FESTIVAL_EDITIONS.find(e=>e.id==='roadburn-2027');
const graspop=OFFICIAL_FESTIVAL_EDITIONS.find(e=>e.id==='graspop-2027');
const dateHtml='<html><body>The festival will take place in Tilburg between April 15-18, 2027.</body></html>';
const lineupHtml='<main>'+['Neurosis','Emma Ruth Rundle','MONO','Kulk','Sadness','Trhä'].map((n,i)=>
  '<a href="/band/test-'+i+'/"><h3>'+n+'</h3></a>').join('')+
  '<a href="/news/1">Imaginary Band</a><div>Other festival lineup: Tool</div></main>';
const graspopDate='<p>Graspop Metal Meeting 2027 vindt plaats van 17 tot en met 20 juni in Dessel.</p>';
const graspopLineup='<ul>'+['A.A. Williams','Paradise Lost','Igorrr','Brutus','Boris','Kreator'].map((name,i)=>
  '<li><a href="/nl/bands/a-'+i+'">first time '+name+' donderdag • Metal Dome</a></li>').join('')+'</ul>';

test('parses only linked bands of the verified official edition',()=>{
  const found=parseOfficialFestival(lineupHtml,dateHtml,road);
  assert.equal(found.concertId,'roadburn-2027');
  assert.deepEqual(found.lineup,['Neurosis','Emma Ruth Rundle','MONO','Kulk','Sadness','Trhä']);
  assert.equal(found.date,'2027-04-15');
  assert.equal(found.source,'officialfestival');
  assert.equal(found.lineup.includes('Imaginary Band'),false);
  assert.equal(found.lineup.includes('Tool'),false);
});
test('graspop official band links remove stage and day labels',()=>{
  const found=parseOfficialFestival(graspopLineup,graspopDate,graspop);
  assert.deepEqual(found.lineup,['A.A. Williams','Paradise Lost','Igorrr','Brutus','Boris','Kreator']);
  assert.equal(found.country,'BE');
});
test('wrong edition, unverified date or short list never publish',()=>{
  assert.equal(parseOfficialFestival(lineupHtml,dateHtml.replace('2027','2026'),road),null);
  assert.equal(parseOfficialFestival(lineupHtml,'<p>No confirmed date</p>',road),null);
  assert.equal(parseOfficialFestival('<a href="/band/a/">Neurosis</a>',dateHtml,road),null);
  assert.equal(parseOfficialFestival(lineupHtml,dateHtml,{...road,id:'unknown'}),null);
});
test('official discoverer searches only selected approved editions and caches verifications',async()=>{
  let calls=0;const cache={};
  const fetcher=async url=>{calls++;return url===road.datesUrl?dateHtml:lineupHtml;};
  const opts={trackedArtistNames:['MONO'],startDate:'2027-01-01',endDate:'2027-06-30',
    countries:['NL'],editions:[road,graspop],cache,now:100000000,pause:async()=>{},fetcher};
  const first=await discoverOfficialFestivals(opts);
  assert.deepEqual(first.events.map(x=>x.festivalName),['Roadburn']);
  assert.deepEqual(first.events[0].matchedTracked,['MONO']);
  assert.equal(first.stats.verified,1);
  assert.equal(calls,2);
  const repeat=await discoverOfficialFestivals({...opts,now:100000001,fetcher:async()=>{throw Error('No refetch expected');}});
  assert.equal(repeat.stats.reused,1);
});
test('failed official checks preserve prior verified snapshot temporarily, not forever',async()=>{
  const cache={};
  await discoverOfficialFestivals({trackedArtistNames:['MONO'],startDate:'2027-04-01',endDate:'2027-04-30',
    editions:[road],cache,now:100000000,pause:async()=>{},fetcher:async u=>u===road.datesUrl?dateHtml:lineupHtml});
  const result=await discoverOfficialFestivals({trackedArtistNames:['MONO'],startDate:'2027-04-01',endDate:'2027-04-30',
    editions:[road],cache,now:100000000+86400000,pause:async()=>{},fetcher:async()=>{throw Error('offline');}});
  assert.equal(result.events.length,1);assert.equal(result.stats.failed,1);
  const expired=await discoverOfficialFestivals({trackedArtistNames:['MONO'],startDate:'2027-04-01',endDate:'2027-04-30',
    editions:[road],cache,now:100000000+8*86400000,pause:async()=>{},fetcher:async()=>{throw Error('offline');}});
  assert.equal(expired.events.length,0);
});
const festivalInfo={source:'festivalinfo',concertId:'36695',festivalName:'Roadburn',date:'2027-04-15',
  endDate:'2027-04-18',city:'Tilburg',country:'NL',venue:'Roadburn',isFestival:true,
  url:'https://www.festivalinfo.nl/festival/36695/Roadburn/2027/',
  lineup:['Neurosis','Emma Ruth Rundle'],matchedTracked:['Neurosis'],image:null};
const official={...parseOfficialFestival(lineupHtml,dateHtml,road),matchedTracked:['Neurosis','MONO']};
test('official updates preserve Festivalinfo identity and the original Pass baseline',()=>{
  const result=mergeOfficialFestivalEvents([festivalInfo], [official],{editions:{}});
  assert.equal(result.events.length,1);
  const updated=result.events[0];
  assert.equal(updated.source,'festivalinfo');
  assert.equal(updated.concertId,'36695');
  assert.equal(updated.url,festivalInfo.url);
  assert.equal(updated.officialUrl,road.lineupUrl);
  assert.equal(updated.sourceApis.includes('officialfestival'),true);
  const old={source:'festivalinfo',sourceId:'36695',date:'2027-04-15',
    isFestival:true,lineup:festivalInfo.lineup,dismissedAt:'2026-11-01T12:00Z'};
  const fresh=festivalLineupRevisit(updated,old,new Map([['mono',{playcount:1000}],['neurosis',{playcount:50}]]));
  assert.deepEqual(fresh.newMatchingArtists,['MONO']);
});
test('previous Festivalinfo cache supplies canonical ID if only official source discovers match',()=>{
  const result=mergeOfficialFestivalEvents([], [official],{editions:{
    [festivalInfo.url]:{event:festivalInfo}
  }});
  assert.equal(result.events.length,1);
  assert.equal(result.events[0].concertId,'36695');
  assert.equal(result.events[0].source,'festivalinfo');
});
test('truly new official festival publishes once with stable original identity',()=>{
  const result=mergeOfficialFestivalEvents([], [official],{editions:{}});
  assert.equal(result.events[0].source,'officialfestival');
  assert.equal(result.events[0].concertId,'roadburn-2027');
  const rerun=mergeOfficialFestivalEvents(result.events,[official],{editions:{}});
  assert.equal(rerun.events.length,1);
});
test('two sources for the same edition do not cause duplicate Deciding cards',()=>{
  const podium={...festivalInfo,source:'podiuminfo',concertId:'1234'};
  const result=mergeOfficialFestivalEvents([podium,festivalInfo],[official],{editions:{}});
  assert.equal(result.events.length,1);
  assert.equal(result.events[0].concertId,'36695');
});
test('official-only editions can return to Deciding on new matched band',()=>{
  const dismissed={source:'officialfestival',sourceId:'roadburn-2027',
    date:'2027-04-15',isFestival:true,lineup:['Neurosis'],
    dismissedAt:'2026-11-01T12:00Z'};
  const fresh=festivalLineupRevisit(official,dismissed,new Map([['mono',{playcount:600}]]));
  assert.deepEqual(fresh.newMatchingArtists,['MONO']);
});
test('discovery workflow persists the official cache and the main pipeline merges before scoring',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/discover-concerts.yml',import.meta.url),'utf8');
  const script=readFileSync(new URL('./discover-concerts.mjs',import.meta.url),'utf8');
  assert.match(workflow,/data\/official-festival-cache\.json/);
  assert.match(script,/mergeOfficialFestivalEvents\(events,official.events,FESTIVAL_CACHE\)/);
  assert.match(script,/officialStats/);
});
