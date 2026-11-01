import test from 'node:test';
import assert from 'node:assert/strict';
import {getSyncedLyrics,pickBestSyncedResult,parseLrc,cleanTrackTitle,currentLine,cacheKey,_clearCache} from '../js/lyrics.js';
const sig={artist:'Example Band',track:'Example Song',album:'Example Album',durationSec:180};
const record=(extra={})=>({artistName:sig.artist,trackName:sig.track,albumName:sig.album,duration:180,syncedLyrics:'[00:01.00]Example first line\n[00:02.00]Example second line',...extra});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function setup(t,handler){_clearCache();t.mock.method(globalThis,'fetch',handler);}
test('exact synced lyrics preserve playback line selection and do not call fallback',async t=>{
  const calls=[];setup(t,async u=>{calls.push(u);return json(record());});
  const r=await getSyncedLyrics(sig);assert.equal(r.status,'synced');assert.equal(currentLine(r.lines,1500),'Example first line');assert.equal(calls.length,1);
});
test('exact-endpoint outage still searches LRCLIB',async t=>{
  setup(t,async u=>u.includes('/api/get?')?json({},503):json([record()]));
  assert.equal((await getSyncedLyrics(sig)).status,'synced');
});
test('plain LRCLIB lyrics are retained, marked unsynced, and never assigned timestamps',async t=>{
  setup(t,async u=>{assert.ok(!u.includes('lyrics.ovh'));return json(u.includes('/api/search?')?[record({syncedLyrics:null,plainLyrics:'Example plain text'})]:record({syncedLyrics:null,plainLyrics:'Example plain text'}));});
  const r=await getSyncedLyrics(sig);assert.equal(r.status,'plain');assert.equal(r.lines,null);assert.equal(r.source,'LRCLIB');assert.equal(r.plainLyrics,'Example plain text');
});
test('lyrics.ovh is a plain-text fallback after LRCLIB misses',async t=>{
  const calls=[];setup(t,async u=>{calls.push(u);return u.includes('lyrics.ovh')?json({lyrics:'Example fallback text'}):json(null,404);});
  const r=await getSyncedLyrics(sig);assert.equal(r.source,'lyrics.ovh');assert.equal(r.lines,null);assert.equal(r.status,'plain');assert.ok(calls.at(-1).endsWith('/Example%20Band/Example%20Song'));
});
test('remaster metadata is cleaned while live, acoustic and remix identities remain distinct',()=>{
  assert.equal(cleanTrackTitle('Example Song - 2011 Remaster'),'Example Song');
  assert.equal(cleanTrackTitle('Example Song (Remastered 2011)'),'Example Song');
  for(const suffix of [' - Live',' (Acoustic)',' - Remix',' - Radio Edit'])assert.equal(cleanTrackTitle('Example Song'+suffix),'Example Song'+suffix);
  assert.equal(pickBestSyncedResult([record({trackName:'Example Song - Live'})],sig),null);
  assert.equal(pickBestSyncedResult([record({artistName:'Other Band'})],sig),null);
});
test('duration and album stay in cache identity; incompatible versions are rejected',()=>{
  assert.notEqual(cacheKey('a','b','c',180),cacheKey('a','b','c',300));
  assert.notEqual(cacheKey('a','b','c',180),cacheKey('a','b','d',180));
  assert.equal(pickBestSyncedResult([record({duration:400})],sig),null);
  assert.equal(pickBestSyncedResult([record({duration:185}),record({duration:180})],sig).duration,180);
});
test('malformed LRC is not treated as successfully synced',async t=>{
  setup(t,async u=>u.includes('lyrics.ovh')?json({lyrics:'Example fallback text'}):json(u.includes('/api/get?')?record({syncedLyrics:'No timestamps'}):[record({syncedLyrics:'[00:99.00]Invalid time'})]));
  assert.equal((await getSyncedLyrics(sig)).status,'plain');
});
test('LRC supports repeated timestamps, offsets and fractional precision',()=>{
  assert.deepEqual(parseLrc('[offset:-100]\n[00:01.2][00:02.345]Example line'),[{ms:1100,text:'Example line'},{ms:2245,text:'Example line'}]);
  assert.equal(currentLine([{ms:0,text:'test'}],undefined),null);assert.equal(currentLine([{ms:0,text:'test'}],NaN),null);
});
test('confirmed instrumental is explicit and does not search another provider',async t=>{
  setup(t,async()=>json(record({instrumental:true,syncedLyrics:null})));
  const r=await getSyncedLyrics(sig);assert.equal(r.status,'instrumental');assert.equal(r.instrumental,true);
});
test('concurrent requests share one lookup and successful results are cached',async t=>{
  let count=0;setup(t,async()=>{count++;return json(record());});
  const [a,b]=await Promise.all([getSyncedLyrics(sig),getSyncedLyrics(sig)]);assert.deepEqual(a,b);assert.equal(count,1);
  await getSyncedLyrics(sig);assert.equal(count,1);await getSyncedLyrics(sig,{force:true});assert.equal(count,2);
});
test('network failures are temporary, misses expire, and Retry bypasses cache',async t=>{
  let now=1e12,calls=0;setup(t,async()=>{calls++;throw Error('offline');});t.mock.method(Date,'now',()=>now);
  assert.equal((await getSyncedLyrics(sig)).status,'unavailable');const first=calls;
  await getSyncedLyrics(sig);assert.equal(calls,first);now+=31000;await getSyncedLyrics(sig);assert.ok(calls>first);
});
test('a confirmed miss differs from source failure and invalid input makes no requests',async t=>{
  let calls=0;setup(t,async()=>{calls++;return json(null,404);});
  assert.equal((await getSyncedLyrics(sig)).status,'not-found');const first=calls;
  await getSyncedLyrics({...sig,artist:''});assert.equal(calls,first);
});
