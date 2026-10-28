import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pendingWarmupRequests,warmupRequestKey,warmupIdentity,selectWarmupReference} from '../js/warmup-setlist-model.js';
import {requestWarmupSetlist} from '../js/warmup-setlist-request.js';
const now=Date.parse('2026-10-29T12:00Z');
const c={id:'going',artist:'Band',date:'2027-01-15',venue:'Room',city:'Utrecht',country:'NL',supportingArtists:['Guest Band']};
const request=(artist='Band',id='request-one')=>({concertId:c.id,artist,identity:warmupIdentity(c,artist),requestedAt:new Date(now).toISOString(),requestId:id});
const results=r=>({version:1,concerts:{[c.id]:{artists:{band:r}}}});
const cache={artist:'Band',targetIdentity:warmupIdentity(c,'Band'),requestId:'request-one',lastAttemptAt:new Date(now-3600000).toISOString()};
function io(queue={version:1,requests:{}},store={version:1,concerts:{}}) {
 let writes=0;
 return {read:async(config,path)=>({json:structuredClone(path.includes('requests')?queue:store),sha:'sha'}),write:async(config,path,value)=>{writes++;queue=value;},get queue(){return queue;},get writes(){return writes;}};
}
test('no requests means no upcoming setlist lookups',()=>{
 assert.deepEqual(pendingWarmupRequests({concerts:[c]},{requests:{}},{concerts:{}},now),[]);
});
test('only the requested band is queued, rather than every headliner and support',()=>{
 const r=request('Guest Band'),q={requests:{[warmupRequestKey(c,r.artist)]:r}};
 const pending=pendingWarmupRequests({concerts:[c]},q,{concerts:{}},now);
 assert.deepEqual(pending.map(p=>p.artist),['Guest Band']);
});
test('processed requests stay cached; a new request ID explicitly refreshes',()=>{
 const q={requests:{[warmupRequestKey(c,'Band')]:request()}};
 assert.equal(pendingWarmupRequests({concerts:[c]},q,results(cache),now).length,0);
 q.requests[warmupRequestKey(c,'Band')]=request('Band','request-two');
 assert.equal(pendingWarmupRequests({concerts:[c]},q,results(cache),now).length,1);
});
test('changed concert identity, unbilled artists and expired requests are rejected',()=>{
 for(const r of [{...request(),identity:'changed'},request('Wrong band'),{...request(),requestedAt:'2026-01-01T00:00Z'}]) {
  assert.equal(pendingWarmupRequests({concerts:[c]},{requests:{[warmupRequestKey(c,r.artist)]:r}},results(cache),now).length,0);
 }
});
test('opening a saved setlist returns the cache without writing a request',async()=>{
 const fake=io(undefined,results(cache));
 const r=await requestWarmupSetlist({},c,'Band',{...fake,now});
 assert.ok(r.data);assert.equal(fake.writes,0);
});
test('opening an already pending search does not submit it twice',async()=>{
 const fake=io({version:1,requests:{[warmupRequestKey(c,'Band')]:request()}});
 const r=await requestWarmupSetlist({},c,'Band',{...fake,now});
 assert.equal(r.request.requestId,'request-one');assert.equal(fake.writes,0);
});
test('first search adds only its artist and preserves other requests',async()=>{
 const fake=io({version:1,requests:{other:{requestId:'keep'}}});
 await requestWarmupSetlist({},c,'Band',{...fake,now,requestId:'new'});
 assert.equal(fake.writes,1);assert.equal(fake.queue.requests.other.requestId,'keep');
 assert.equal(fake.queue.requests[warmupRequestKey(c,'Band')].requestId,'new');
});
test('conflicting writes re-read the queue without losing another band',async()=>{
 let reads=0,writes=0,saved;
 const read=async(config,path)=>{
  if(!path.includes('requests'))return {json:{version:1,concerts:{}}};
  reads++;return {json:{version:1,requests:reads>1?{other:{requestId:'concurrent'}}:{}},sha:String(reads)};
 };
 const write=async(config,path,data)=>{if(!writes++){const e=Error('Conflict');e.status=409;throw e;}saved=data;};
 await requestWarmupSetlist({},c,'Band',{read,write,now,requestId:'new'});
 assert.equal(saved.requests.other.requestId,'concurrent');assert.equal(writes,2);
});
test('manual refresh has a cooldown instead of repeated API calls',async()=>{
 const fake=io(undefined,results({...cache,lastAttemptAt:new Date(now-1000).toISOString()}));
 await assert.rejects(requestWarmupSetlist({},c,'Band',{...fake,now,force:true}),/five minutes/);
 assert.equal(fake.writes,0);
});
test('a saved setlist remains available without automatic expiry',()=>{
 const r={...cache,artist:'Band',matchType:'recent-reference',sourceUrl:'https://www.setlist.fm/setlist/band/2025/test.html',sourceEvent:{artist:'Band',date:'2025-01-01'},sets:[{songs:['Song']}]};
 assert.equal(selectWarmupReference(c,'Band',results(r),new Map(),'2026-10-29'),r);
});
test('warm-up workflow is request-driven and the archive workflow does not fetch Going',()=>{
 const warmup=readFileSync(new URL('../.github/workflows/fetch-warmup-setlists.yml',import.meta.url),'utf8');
 const archive=readFileSync(new URL('../.github/workflows/fetch-setlists.yml',import.meta.url),'utf8');
 assert.ok(warmup.includes('data/warmup-setlist-requests.json'));assert.ok(!warmup.includes('cron:'));
 assert.ok(!archive.includes('fetch-warmup-setlists.mjs'));
});
