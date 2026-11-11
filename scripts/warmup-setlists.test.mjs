import test from 'node:test';
import assert from 'node:assert/strict';
import {warmupArtists,warmupArtistKey,referenceDate,validWarmupReference,selectWarmupReference,sameTourReference,automaticWarmupCandidates} from '../js/warmup-setlist-model.js';
import {buildSetlistGuide} from '../js/setlist-prediction.js';
import {resolveWarmupSetlist} from './lib/warmup-setlist-resolver.mjs';
const now=Date.parse('2026-10-29T12:00Z'),today='2026-10-29';
const c={id:'going-one',artist:'Band + Guest Band',date:'2027-01-15',venue:'Room',city:'Utrecht',country:'NL',schedule:{date:'2027-01-15',main:{name:'Band'},support:[{name:'Guest Band'},{name:'GUEST BAND'}]}};
const record=(artist='Band',date='2026-10-28')=>({artist,matchType:'recent-reference',matchingVersion:5,sourceUrl:'https://www.setlist.fm/setlist/band/2026/example.html',sourceEvent:{artist,date,venue:'Other room',city:'Berlin',tour:'Recent Tour'},sets:[{name:'Set',songs:['Song one','Song two']}],targetIdentity:JSON.stringify([artist,c.date,c.venue,c.city,c.country])});
const api=(date='28-10-2026',name='Band',id='one',tour='Recent Tour')=>({id,eventDate:date,artist:{name,mbid:'artist-one'},tour:{name:tour},url:'https://www.setlist.fm/setlist/band/2026/'+id+'.html',venue:{name:'Other room',city:{name:'Berlin',country:{code:'DE'}}},sets:{set:[{song:[{name:'Song one'}]}]}});
const response=items=>({setlist:items,page:1,itemsPerPage:20,total:items.length});
test('warm-up artists use verified headliner and all named supports once',()=>{
 assert.deepEqual(warmupArtists(c),['Band','GUEST BAND']);
 assert.deepEqual(warmupArtists({...c,schedule:{...c.schedule,noSupport:{kind:'official'}}}),['Band']);
 assert.deepEqual(warmupArtists({...c,schedule:{...c.schedule,date:'2025-01-01'}}),['Band + Guest Band']);
});
test('reference dates reject invalid dates and support setlist.fm date format',()=>{
 assert.equal(referenceDate('28-10-2026'),'2026-10-28');assert.equal(referenceDate('2026-02-30'),null);
});
test('future, stale, wrong artist and unsafe source references are rejected',()=>{
 assert.ok(validWarmupReference(record(),'Band',today));
 for(const r of [record('Other'),record('Band','2026-10-30'),record('Band','2025-01-01'),{...record(),sourceUrl:'https://evil.test/'},{...record(),sets:{}},{...record(),sourceEvent:{...record().sourceEvent,artist:'Other'}}])assert.equal(validWarmupReference(r,'Band',today),false);
});
test('target-specific setlist is preferred and must match current concert identity',()=>{
 const r=record(),snapshot={concerts:{[c.id]:{artists:{band:r}}}};
 assert.equal(selectWarmupReference(c,'Band',snapshot,new Map(),today),r);
 assert.equal(selectWarmupReference({...c,date:'2027-01-16'},'Band',snapshot,new Map(),today),null);
});
test('archived setlists become clearly labelled recent references, not evidence of upcoming tour',()=>{
 const old={...record(),matchType:'tour-reference',tourEvidence:{kind:'concert-tour',tour:'Recent Tour'}};
 const r=selectWarmupReference(c,'Band',null,new Map([['old',{artists:{band:old}}]]),today);
 assert.equal(r.matchType,'recent-reference');assert.equal(sameTourReference(r),false);
});
test('only verified matching tour evidence enables same-tour label',()=>{
 assert.equal(sameTourReference({...record(),matchType:'tour-reference',tourEvidence:{kind:'concert-tour',tour:'Recent Tour'}}),true);
 assert.equal(sameTourReference({...record(),matchType:'tour-reference',tourEvidence:{kind:'concert-tour',tour:'Different Tour'}}),false);
});
test('upcoming shows use latest completed recent show, not a future or differently named act',async()=>{
 const get=async raw=>{
  const u=new URL(raw);if(u.searchParams.has('date'))return response([]);
  return response([api('30-10-2026','Band','future'),api('28-10-2026','Other','wrong'),api('20-10-2026','Band','older'),api('28-10-2026','Band','newest')]);
 };
 const r=await resolveWarmupSetlist(c,'Band',get,now);
 assert.equal(r.setlistFmId,'newest');assert.equal(r.matchType,'recent-reference');
});
test('same tour is preferred when future event or concert metadata establishes it',async()=>{
 const concert={...c,artist:'Band',date:'2026-11-10',tourName:'Recent Tour'};
 const get=async raw=>new URL(raw).searchParams.has('date')?response([]):response([api()]);
 const r=await resolveWarmupSetlist(concert,'Band',get,now);
 assert.equal(r.matchType,'tour-reference');assert.equal(sameTourReference(r),true);
});
test('different artist identities sharing a name are not guessed',async()=>{
 const get=async raw=>{
  if(new URL(raw).searchParams.has('date'))return response([]);
  return response([api(),{...api('27-10-2026','Band','two'),artist:{name:'Band',mbid:'artist-two'}}]);
 };
 assert.equal(await resolveWarmupSetlist(c,'Band',get,now),null);
});
test('missing results remain empty and API failures propagate for safe retry',async()=>{
 assert.equal(await resolveWarmupSetlist(c,'Band',async()=>null,now),null);
 await assert.rejects(resolveWarmupSetlist(c,'Band',async()=>{throw Error('Setlist API HTTP 429');},now));
});


test('five recent shows generate song observations rather than a guessed running order',async()=>{
 const dates=['28-10-2026','27-10-2026','26-10-2026','25-10-2026','24-10-2026'];
 const rows=dates.map((date,i)=>({...api(date,'Band','show-'+i),
   sets:{set:[{song:[{name:'Always'},{name:i<4?'Frequent':'Alternate'},
     ...(i<2?[{name:'Rare'}]:[])]}]}}));
 const get=async()=>response(rows);
 const found=await resolveWarmupSetlist(c,'Band',get,now);
 assert.equal(found.references.length,5);
 assert.equal(found.references[0].sourceEvent.date,'2026-10-28');
 const guide=buildSetlistGuide(found,'Band',today,c.date);
 assert.equal(guide.showCount,5);
 assert.equal(guide.songs.find(s=>s.name==='Always').observed,'5/5 shows');
 assert.equal(guide.songs.find(s=>s.name==='Frequent').observed,'4/5 shows');
 assert.equal(guide.songs.find(s=>s.name==='Rare').observed,'2/5 shows');
});
test('single, stale and duplicate source references never imply 80% certainty',()=>{
 const old=record('Band','2026-01-01');
 const guide=buildSetlistGuide({...old,references:[old,old]},'Band',today,c.date);
 assert.equal(guide.showCount,1);assert.equal(guide.stale,true);
 assert.equal(guide.limited,true);assert.equal(guide.songs[0].observed,'1/1 shows');
});
test('future, wrong-artist and malicious sources do not enter guide frequency counts',()=>{
 const valid=record();
 const found=buildSetlistGuide({...valid,references:[valid,
  record('Other'),record('Band','2026-10-30'),
  {...record(),sourceUrl:'https://evil.example.com/'}]},'Band',today,c.date);
 assert.equal(found.showCount,1);
});
test('daily automatic lookups are limited to headliners seven days before the show',()=>{
 const t=Date.parse('2026-11-04T12:00Z');
 const soon={...c,artist:'Band',date:'2026-11-10',supportingArtists:['Guest Band'],schedule:null};
 const farther={...soon,id:'later',date:'2026-11-12'};
 const festival={...soon,id:'festival',isFestival:true};
 const planned={concerts:[soon,farther,festival]};
 const queue=automaticWarmupCandidates(planned,{concerts:{}},t);
 assert.deepEqual(queue.map(q=>q.c.id),[soon.id]);
 assert.deepEqual(queue.map(q=>q.artist),['Band']);
 const recent={concerts:{[soon.id]:{artists:{band:{targetIdentity:JSON.stringify(['Band',soon.date,soon.venue,soon.city,soon.country]),
   lastAttemptAt:new Date(t-3600000).toISOString()}}}}};
 assert.equal(automaticWarmupCandidates(planned,recent,t).length,0);
 assert.equal(automaticWarmupCandidates({concerts:[{...soon,date:'2026-11-04'}]}, {concerts:{}},t).length,1);
});
test('multiple known tour shows take priority over unrelated festivals',async()=>{
 const concert={...c,artist:'Band',tourName:'Current Tour'};
 const show=(id,date,tour)=>({...api(date,'Band',id,tour),
   sets:{set:[{song:[{name:'Regular'}]}]}});
 const rows=[show('old','26-10-2026','Other Tour'),
  show('current-2','25-10-2026','Current Tour'),
  show('current-1','27-10-2026','Current Tour')];
 const result=await resolveWarmupSetlist(concert,'Band',async()=>response(rows),now);
 assert.equal(result.references.length,2);
 assert.equal(result.references[0].setlistFmId,'current-1');
 assert.equal(sameTourReference(result),true);
});
