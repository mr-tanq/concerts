import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSchedule,mergeSchedule} from './sources/concert-schedule.mjs';
import {scheduleMarkup} from '../js/concert-schedule.js';

const now='2026-10-28T21:00:00Z';
const c={
  id:'billing-test',
  artist:'Example Headliner + Guest One + Guest Two',
  date:'2027-04-18',venue:'Patronaat',country:'NL'
};
const url='https://patronaat.nl/event/example/';
const roles=()=>['Guest One','Guest Two'].map(name=>
  `<div class="event__support-act--info"><h3>Support</h3><h2>${name}</h2></div>`
).join('');
const patronaat=(extra='')=>`<main>
<h1>${c.artist}</h1><time datetime="${c.date}"></time>
<p>Deuren: 18:30</p><p>Start: 19:00</p>
${roles()}${extra}</main>`;
const parse=html=>parseSchedule(html,c,url,'official',now);

test('explicit support roles separate a compound bill without inventing main times',()=>{
  const s=mergeSchedule(c,[parse(patronaat())],now,'manual');
  assert.equal(s.main.name,'Example Headliner');
  assert.equal(s.main.time,null);
  assert.equal(s.doors.time,'18:30');
  assert.equal(s.start.time,'19:00');
  assert.equal(s.start.unassigned,true);
  assert.deepEqual(s.support.map(a=>[a.name,a.time]),[
    ['Guest One',null],['Guest Two',null]
  ]);
});

test('explicit timetable lines recognize individual artist names',()=>{
  const extra='<p>Example Headliner: 21:00</p><p>Guest One: 19:00</p><p>Guest Two: 20:00</p>';
  const s=mergeSchedule(c,[parse(patronaat(extra))],now,'manual');
  assert.equal(s.main.time,'21:00');
  assert.deepEqual(s.support.map(a=>a.time),['19:00','20:00']);
});

test('legitimate plus names and co-headliner titles are not blindly split',()=>{
  for(const artist of ['Florence + The Machine','Act One + Act Two']) {
    const concert={...c,artist};
    const html=`<main><h1>${artist}</h1><time datetime="${c.date}"></time><p>Doors: 18:30</p></main>`;
    const r=parseSchedule(html,concert,url);
    assert.equal(r.mainName,artist);
    assert.deepEqual(r.supportNames,[]);
  }
});

test('secondary pages cannot assign venue-specific billing roles',()=>{
  const r=parseSchedule(patronaat(),c,url,'secondary',now);
  assert.equal(r.mainName,c.artist);
  assert.deepEqual(r.supportNames,[]);
});

test('support names are deduplicated across casing and saved records',()=>{
  const concert={...c,supportingArtists:['GUEST ONE']};
  const s=mergeSchedule(concert,[parse(patronaat())],now,'manual');
  assert.equal(s.support.length,2);
});

test('Effenaar event bar and subtitle provide doors, programme and supports',()=>{
  const concert={...c,artist:'Another Artist',venue:'Effenaar'};
  const html=`<main>
  <div class="header-inner"><h1>Another Artist</h1>
  <span class="header-subtitle">Metal night | + First Guest + Second Guest</span></div>
  <time datetime="${c.date}"></time>
  <div class="event-bar-item time">
  <span class="time-start-end">19:00</span>
  <span class="time-open">Zaal open om 18:30</span>
  </div></main>`;
  const u='https://www.effenaar.nl/agenda/another-artist';
  const r=parseSchedule(html,concert,u,'official',now);
  const s=mergeSchedule(concert,[r],now,'manual');
  assert.equal(s.doors.time,'18:30');
  assert.equal(s.start.time,'19:00');
  assert.equal(s.main.time,null);
  assert.deepEqual(s.support.map(a=>a.name),['First Guest','Second Guest']);
  assert.equal(parseSchedule(html,{...concert,date:'2027-04-19'},u),null);
});

test('fresh evidence removes an old derived combined main time and renders the headliner',()=>{
  const old={...c,schedule:{
    date:c.date,
    main:{
      name:c.artist,time:'19:00',sourceUrl:url,
      sourceKind:'official',derivedFrom:'programme-start'
    }
  }};
  const s=mergeSchedule(old,[parse(patronaat())],now,'manual');
  assert.equal(s.main.name,'Example Headliner');
  assert.equal(s.main.time,null);
  const html=scheduleMarkup({...c,schedule:s});
  const main=html.match(/data-schedule-kind="main"[\s\S]*?<\/div>/)?.[0];
  assert.ok(main.includes('Example Headliner'));
  assert.ok(!main.includes('Guest One'));
});
