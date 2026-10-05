import test from "node:test";
import assert from "node:assert/strict";
import { localDate, venueInstant, validDate, scheduleCountdown, scheduleMarkup, mountSchedule, clearScheduleClock, syncScheduleClock } from "../js/concert-schedule.js";
import { parseSchedule, mergeSchedule, checkPhase, applyUpdates, publishUpdates, enrichOne } from "./enrich-concert-schedules.mjs";

const c = {id:"planned-test",artist:"HÄLLAS",date:"2026-10-08",venue:"Hall Of Fame",city:"Tilburg",country:"NL",supportingArtists:[]};
const url="https://hall-fame.nl/programma/hallas-111628041", stamp="2026-10-05T12:00:00.000Z";
const page=(rows, date=c.date)=>`<html><head><title>HÄLLAS | Hall of Fame</title></head><body><main><h1>HÄLLAS</h1><time datetime="${date}">8 October 2026</time>${rows}</main></body></html>`;
const timeline=(label,time)=>`<div class="timeline-item"><div class="time-title"><span class="time">${time}</span><h4 class="title">${label}</h4></div></div>`;
const html=page(timeline("ZAAL OPEN","19:30")+timeline("EARTH TONGUE","20:30 - 21:00")+timeline("HÄLLAS","21:30 - 23:00"));
const parsed=parseSchedule(html,c,url,"official",stamp);
const schedule=mergeSchedule(c,[parsed],stamp,"initial");
const scheduled={...c,schedule};

test("official timetable preserves four published times and per-field provenance",()=>{
  assert.equal(schedule.doors.time,"19:30"); assert.equal(schedule.support[0].name,"EARTH TONGUE"); assert.equal(schedule.support[0].time,"20:30");
  assert.equal(schedule.main.time,"21:30"); assert.equal(schedule.end.time,"23:00");
  assert.equal(schedule.main.at,"2026-10-08T19:30:00.000Z");assert.equal(schedule.main.sourceUrl,url);assert.equal(schedule.main.sourceKind,"official");
  assert.equal(schedule.lastCheckedAt,stamp);assert.equal(schedule.checks.initial,stamp);
});
test("generic start and existing concert.time are never guessed as a main act",()=>{
  const r=parseSchedule(page('<p>Start 20:00</p><p>Time 19:30</p>'),{...c,time:"20:00"},url,"official",stamp);
  assert.deepEqual(r.values,{});const s=mergeSchedule(c,[r],stamp,"initial");assert.equal(s.main.time,null);assert.equal(s.doors.time,null);
});
test("wrong artist and date, navigation, related shows and biography are rejected",()=>{
  assert.equal(parseSchedule(html.replaceAll("HÄLLAS","OTHER BAND"),c,url),null);
  assert.equal(parseSchedule(page('<p>DOORS 19:30</p>',"2026-10-09").replace('8 October 2026','9 October 2026'),c,url),null);
  const r=parseSchedule(page('<p>In 2020 HÄLLAS played at 21:30.</p><aside><p>Doors 18:00</p></aside><div class="related-shows"><p>End 22:00</p></div>'),c,url);
  assert.deepEqual(r.values,{});
});
test("removed official time becomes TBA, not a secondary replacement",()=>{
  const weak=parseSchedule(page('<p>Doors 18:00</p><p>Main act 20:00</p>'),c,"https://www.podiuminfo.nl/concert/1/","secondary",stamp);
  const newer=parseSchedule(page('<p>Doors 19:45</p>'),c,url,"official","2026-10-06T12:00:00Z");
  const s=mergeSchedule(scheduled,[weak,newer],"2026-10-06T12:00:00Z","before48h");assert.equal(s.doors.time,"19:45");assert.equal(s.main.time,null);
});
test("failed requests retain confirmed evidence and do not complete a checkpoint",()=>{
  const s=mergeSchedule(scheduled,[],"2026-10-06T12:00:00Z","before48h");assert.equal(s.main.time,"21:30");assert.equal(s.lastCheckedAt,stamp);assert.equal(s.checks.before48h,undefined);assert.ok(s.lastError);
});
test("one source contradicting itself cannot select a time arbitrarily",()=>{
  const r=parseSchedule(page('<p>Doors 19:30</p><p>Doors 19:45</p>'),c,url);assert.equal(r.values.doors,undefined);assert.ok(r.conflicts.includes("doors"));
});
test("conflicting official sources and non-timetable date/price fields remain TBA",()=>{
  const other=parseSchedule(page('<p>Doors 19:45</p>'),c,"https://hall-fame.nl/programma/hallas-other-2","official",stamp);
  assert.equal(mergeSchedule(c,[parsed,other],stamp,"initial").doors.time,null);
  const r=parseSchedule(page('<dl><dt>Date</dt><dd>08.10.2026</dd><dt>Price</dt><dd>24.75</dd><dt>Doors</dt><dd>19:30</dd></dl>'),c,url);
  assert.equal(r.values.doors.time,"19:30");assert.equal(Object.keys(r.values).length,1);
});
test("expected end is labelled and timestamps with offsets become local venue time",()=>{
  const r=parseSchedule(page('<p>Expected end 23:00</p>'),c,url);assert.equal(r.values.end.status,"expected");
  const ld=`<script type="application/ld+json">${JSON.stringify({"@type":"MusicEvent",name:c.artist,startDate:"2026-10-08T18:00:00Z",doorTime:"2026-10-08T17:30:00Z",endDate:"2026-10-08T21:00:00Z"})}</script>`;
  const p=parseSchedule(page('')+ld,c,url);assert.equal(p.values.doors.time,"19:30");assert.equal(p.values.end.time,"23:00");assert.equal(p.values.main,undefined);
});
test("venue time is independent of phone timezone and DST-invalid times are TBA",()=>{
  assert.equal(localDate(Date.parse("2026-10-07T22:30:00Z")),"2026-10-08");
  assert.equal(venueInstant(c.date,"19:30"),"2026-10-08T17:30:00.000Z");assert.equal(venueInstant("2026-11-08","19:30"),"2026-11-08T18:30:00.000Z");
  assert.equal(venueInstant("2026-10-25","02:30"),null);assert.equal(venueInstant("2026-03-29","02:30"),null);
  for(const bad of ["2026-02-30","2026-99-99","",null]) assert.equal(validDate(bad),false);
});
test("48h, 24h and same-day windows execute once, with hourly day-of retries",()=>{
  assert.equal(checkPhase(scheduled,Date.parse("2026-10-06T17:31:00Z")),"before48h");
  assert.equal(checkPhase({...scheduled,schedule:{...schedule,checks:{before48h:stamp}}},Date.parse("2026-10-06T18:00Z")),null);
  assert.equal(checkPhase(scheduled,Date.parse("2026-10-07T17:31Z")),"before24h");
  assert.equal(checkPhase(scheduled,Date.parse("2026-10-07T22:01Z")),"sameDay");
  assert.equal(checkPhase({...scheduled,schedule:{...schedule,lastAttemptAt:"2026-10-08T09:00Z"}},Date.parse("2026-10-08T09:30Z")),null);
  assert.equal(checkPhase(scheduled,Date.parse("2026-10-08T21:05Z")),null);
  assert.equal(checkPhase(scheduled,Date.parse("2026-10-09T12:00Z")),null);
});
test("local countdown moves doors → support → main → live → ended",()=>{
  for(const [now,expected] of [
    ["2026-10-07T12:00Z",""], ["2026-10-08T14:43Z","DOORS IN 2H 47M"],
    ["2026-10-08T17:48Z","EARTH TONGUE IN 42M"], ["2026-10-08T18:25Z","EARTH TONGUE IN 5M"],
    ["2026-10-08T18:30Z","HÄLLAS IN 1H 00M"], ["2026-10-08T19:30Z","HÄLLAS · LIVE NOW"],
    ["2026-10-08T21:00Z","SHOW ENDED"]]) assert.equal(scheduleCountdown(scheduled,Date.parse(now)),expected);
});
test("unknown times do not produce a countdown or indefinite LIVE NOW",()=>{
  const unknown={...c,schedule:mergeSchedule(c,[],stamp,"initial")};assert.equal(scheduleCountdown(unknown,Date.parse("2026-10-08T12:00Z")),"TIMES TBA");
  assert.equal(scheduleCountdown({...scheduled,schedule:{...schedule,end:{time:null}}},Date.parse("2026-10-08T20:00Z")),"HÄLLAS · START TIME PASSED");
});
test("an explicit main-act range ending after midnight continues correctly",()=>{
  const s=mergeSchedule(c,[parseSchedule(page(timeline("HÄLLAS","23:00 - 01:00")),c,url)],stamp,"initial");
  assert.equal(s.end.dayOffset,1);assert.equal(s.end.at,"2026-10-08T23:00:00.000Z");
  assert.equal(scheduleCountdown({...c,schedule:s},Date.parse("2026-10-08T22:30Z")),"HÄLLAS · LIVE NOW");
});
test("fresh schedules merge without overwriting work edits or resurrecting removals",()=>{
  const data={meta:{},concerts:[{...c,workArrangement:{status:"yes"}}, {...c,id:"new-concert"}]};
  const updates=[{...c,schedule}, {...c,id:"removed-concert",schedule}];assert.equal(applyUpdates(data,updates),true);
  assert.equal(data.concerts.length,2);assert.equal(data.concerts[0].workArrangement.status,"yes");assert.equal(data.concerts[1].schedule,undefined);
  const newer={...schedule,lastAttemptAt:"2026-10-07T12:00Z"};data.concerts[0].schedule=newer;applyUpdates(data,updates);assert.equal(data.concerts[0].schedule,newer);
});
test("a GitHub SHA conflict re-reads latest data and preserves simultaneous app saves",async()=>{
  let reads=0,writes=0,saved;
  const request=async(endpoint,opts)=>{
    if(!opts){reads++;return {sha:`sha${reads}`,content:Buffer.from(JSON.stringify({meta:{},concerts:[{...c,workArrangement:{status:reads===1 ? "notYet" : "yes"}}]})).toString("base64")};}
    writes++;if(writes===1){const e=new Error("conflict");e.status=409;throw e;}saved=JSON.parse(Buffer.from(JSON.parse(opts.body).content,"base64").toString());
  };
  assert.equal(await publishUpdates([{...c,schedule}],request),true);assert.equal(reads,2);assert.equal(saved.concerts[0].workArrangement.status,"yes");
});
test("venue-owned agenda discovers the correct event while rejecting another date",async()=>{
  const requested=[];
  const fetcher=async(u)=>{requested.push(u);if(u.endsWith('/programma'))return{url:u,html:`<a href="/programma/hallas-wrong-1">HÄLLAS</a><a href="/programma/hallas-111628041">HÄLLAS</a>`};if(u.includes('wrong'))return{url:u,html:page('').replaceAll('2026-10-08','2026-10-09').replace('8 October','9 October')};return{url:u,html};};
  const s=await enrichOne(c,stamp,"initial",fetcher);assert.equal(s.main.time,"21:30");assert.ok(requested.some(u=>u.includes("wrong")));assert.equal(s.sources.length,1);
});
test("display escapes external labels, rejects script links and shows TBA/expected/source",()=>{
  const mark=scheduleMarkup({...scheduled,artist:'<img onerror="x">',schedule:{...schedule,main:{name:'<img onerror="x">',time:null},end:{time:"23:00",status:"expected"},sources:[{url:"javascript:alert(1)"},{url,kind:"official"}]}});
  assert.ok(!mark.includes('<img'));assert.ok(!mark.includes('javascript:'));assert.ok(mark.includes('TBA'));assert.ok(mark.includes('expected'));assert.ok(mark.includes('· official'));
});
test("clock starts only for a mounted visible Tonight and makes no network requests",()=>{
  const previous={document:globalThis.document,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval,fetch:globalThis.fetch};
  let active=true,started=0,stopped=0,requests=0;const p={};const host={isConnected:true,querySelector:()=>p};
  globalThis.document={hidden:false,getElementById:()=>({classList:{contains:()=>active}})};
  globalThis.setInterval=()=>{started++;return 9;};globalThis.clearInterval=id=>{if(id)stopped++;};globalThis.fetch=()=>{requests++;throw new Error("unexpected");};
  try {
    mountSchedule(host,scheduled);assert.equal(started,1);active=false;syncScheduleClock();assert.equal(stopped,1);assert.equal(started,1);
    active=true;globalThis.document.hidden=true;syncScheduleClock();assert.equal(started,1);
    globalThis.document.hidden=false;syncScheduleClock();assert.equal(started,2);host.isConnected=false;syncScheduleClock();assert.equal(started,2);assert.equal(requests,0);
  } finally {clearScheduleClock();Object.assign(globalThis,previous);}
});
