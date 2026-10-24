import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichOne} from './enrich-concert-schedules.mjs';
import {parseSchedule,mergeSchedule} from './sources/concert-schedule.mjs';
import {scheduleMarkup} from '../js/concert-schedule.js';

const c={id:'organizer-test',artist:'Placebo',date:'2026-10-27',venue:'Ziggo Dome',country:'NL',supportingArtists:[],officialEventUrl:'https://www.ziggodome.nl/events/1c4d6a23-e91b-4696-9791-ba5eeb2609a4/'};
const stamp='2026-10-24T13:50:00Z';
const mojo='https://mojo.nl/concerten/placebo';
const page=(date=c.date,venue=c.venue)=>`<main><h1>Placebo</h1><time datetime="${date}"></time><p> ${venue} </p><ul>
  <li><div><h3>Deuren open</h3><p>18:30</p></div></li>
  <li><div><h3>Support act The Mirror Trap</h3><p>20:00</p></div></li>
  <li><div><h3>Placebo</h3><p>21:00</p></div></li>
  <li><div><h3>Verwacht einde</h3><p>22:45</p></div></li></ul></main>`;

function mock(html,complete=false) {
  const calls=[];
  const fetcher=async(url,hosts)=>{
    calls.push(url);
    assert.ok(hosts.includes(new URL(url).hostname.replace(/^www\./,'')));
    if(url.includes('/api/search/')) return {url,html:'{"resultsEvents":[]}'};
    if(url.includes('/api/agenda/events/')) return {url,html:JSON.stringify({
      data:[{performerName:'Placebo',showDate:c.date,supportActDescription:'<strong>Support | The Mirror Trap</strong>'}],
      program:[{program:[{title:'Deuren open',time:'18:30'},
        ...(complete?[{title:'The Mirror Trap',time:'20:00'},{title:'Placebo',time:'21:00'}]:[{title:'Aanvang show',time:'21:00'}]),
        {title:'Verwacht einde',time:'22:45'}]}]})};
    if(url==='https://mojo.nl/agenda?query=Placebo') return {url,html:'<a href="#content">Skip to content</a><a href="/concerten/placebo">Placebo</a>'};
    if(url===mojo) return {url,html};
    return {url,html:'<main></main>'};
  };
  return {fetcher,calls};
}

test('partial venue timetable continues to verified organizer and reads named support',async()=>{
  const {fetcher,calls}=mock(page());
  const s=await enrichOne(c,stamp,'manual',fetcher);
  assert.ok(calls.includes(mojo));
  assert.ok(!calls.some(url=>url.includes('#')));
  assert.equal(s.doors.time,'18:30');
  assert.equal(s.main.time,'21:00');
  assert.equal(s.support.find(a=>a.name==='The Mirror Trap').time,'20:00');
  assert.equal(s.support[0].sourceUrl,mojo);
  assert.equal(s.end.time,'22:45');
  assert.equal(s.end.status,'expected');
  assert.ok(!scheduleMarkup({...c,schedule:s}).includes('Separate act times have not been confirmed'));
});

test('organizer for another date or venue cannot fill missing act times',async()=>{
  for(const html of [page('2026-10-28'),page(c.date,'AFAS Live')]) {
    const {fetcher}=mock(html);
    const s=await enrichOne(c,stamp,'manual',fetcher);
    assert.equal(s.main.time,null);
    assert.equal(s.support[0].time,null);
    assert.equal(s.doors.time,'18:30');
  }
});

test('complete venue timetable needs no extra organizer discovery',async()=>{
  const {fetcher,calls}=mock(page(),true);
  const s=await enrichOne(c,stamp,'manual',fetcher);
  assert.equal(s.main.time,'21:00');
  assert.ok(!calls.some(u=>u.includes('mojo.nl')));
});

test('explicit act time resolves an unassigned programme start',()=>{
  const parsed=parseSchedule(page(),c,mojo,'official',stamp);
  const field={time:'21:00',unassigned:true,sourceKind:'official',sourceUrl:c.officialEventUrl,checkedAt:stamp};
  const s=mergeSchedule({...c,schedule:{date:c.date,start:field}},[parsed],stamp,'manual');
  assert.equal(s.start.time,'21:00');
  assert.equal(s.start.unassigned,undefined);
  assert.equal(s.main.time,'21:00');
});
