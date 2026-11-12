import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule,mergeSchedule } from './enrich-concert-schedules.mjs';
import { scheduleMarkup,scheduleCountdown } from '../js/concert-schedule.js';

const c={id:'013-sets',artist:'Example Band',date:'2026-11-03',venue:'013',country:'NL',supportingArtists:[]};
const url='https://www.013.nl/programma/12345/example-band',stamp='2026-11-03T13:00:00Z';
const row=(clock,name)=>`<li class="flex items-start"><b>${clock.split(' - ').map(t=>`<time datetime="2026-11-02T${t}:00+01:00">${t}</time>`).join(' - ')}</b><div class="heading-din">${name}</div></li>`;
// The real publisher's row datetime dates can differ from its verified event
// date. The visible clock is venue wall time; the event identity stays checked.
const page=(rows,ribbon='Tijden',extra='')=>`<main><h1>${c.artist}</h1><time datetime="${c.date}">di 03 nov '26</time>${extra}<div class="relative"><div class="ribbon_basic ribbon_small">${ribbon}</div><ul>${rows}</ul><div>Tijdschema onder voorbehoud</div></div></main>`;
const rows=row('18:30','VIP Check In')+row('19:00','Zaal Open')+row('20:00 - 20:30','Guest Act')+row('21:00 - 21:55',c.artist)+row('21:55 - 22:10','Pauze')+row('22:10 - 22:50',c.artist);
const parsed=(html=page(rows))=>parseSchedule(html,c,url,'official',stamp);
const merged=(html=page(rows))=>mergeSchedule(c,[parsed(html)],stamp,'manual');

test('013 multiple published sets keep the first start and final end with provenance',()=>{
  const result=parsed(),s=merged();
  assert.equal(s.doors.time,'19:00');assert.equal(s.main.time,'21:00');assert.equal(s.end.time,'22:50');
  assert.deepEqual(s.main.sets.map(x=>[x.time,x.endTime]),[['21:00','21:55'],['22:10','22:50']]);
  assert.deepEqual(s.main.breaks.map(x=>[x.time,x.endTime]),[['21:55','22:10']]);
  assert.deepEqual(s.support.map(x=>[x.name,x.time,x.endTime]),[['Guest Act','20:00','20:30']]);
  assert.equal(s.main.sourceUrl,url);assert.ok(s.main.sets.every(x=>x.sourceUrl===url&&x.checkedAt===stamp));
  assert.deepEqual(result.conflicts,[]);assert.ok(!s.support.some(x=>/vip|pauze|break/i.test(x.name)));
});

test('013 English timetable and a single performance keep actual ranges',()=>{
  const s=merged(page(row('19:00','Hall Open')+row('21:00 - 22:50',c.artist),'Times'));
  assert.equal(s.doors.time,'19:00');assert.equal(s.main.time,'21:00');assert.equal(s.end.time,'22:50');assert.equal(s.main.sets.length,1);
});

test('013 display includes both sets, their ranges and the explicit break',()=>{
  const markup=scheduleMarkup({...c,schedule:merged()});
  for(const text of ['20:00–20:30','21:00–21:55','21:55–22:10','22:10–22:50','MAIN ACT · SET 1','MAIN ACT · SET 2','BREAK'])assert.ok(markup.includes(text),text);
  assert.equal((markup.match(/data-schedule-kind="main"/g)||[]).length,2);
  assert.ok(!markup.includes('VIP Check In'));assert.ok(!markup.includes('TBA'));
});

test('013 clock is live only inside sets and counts down to resumption during break',()=>{
  const concert={...c,schedule:merged()};
  for(const [time,label]of [
    ['18:00','DOORS IN 1H 00M'],['20:30','EXAMPLE BAND IN 30M'],
    ['21:00','EXAMPLE BAND · LIVE NOW'],['21:54','EXAMPLE BAND · LIVE NOW'],
    ['21:55','BREAK · EXAMPLE BAND RESUMES IN 15M'],
    ['22:00','BREAK · EXAMPLE BAND RESUMES IN 10M'],
    ['22:10','EXAMPLE BAND · LIVE NOW'],['22:50','SHOW ENDED']
  ])assert.equal(scheduleCountdown(concert,Date.parse(`2026-11-03T${time}:00+01:00`)),label,time);
});

test('013 gaps are not invented as published breaks',()=>{
  const s=merged(page(row('21:00 - 21:55',c.artist)+row('22:10 - 22:50',c.artist)));
  assert.deepEqual(s.main.breaks,[]);
  const markup=scheduleMarkup({...c,schedule:s});assert.ok(!markup.includes('>BREAK<'));
  assert.equal(scheduleCountdown({...c,schedule:s},Date.parse('2026-11-03T21:56:00+01:00')),'EXAMPLE BAND RESUMES IN 14M');
});

test('013 overlapping sets and conflicting unspecialized assertions remain unconfirmed',()=>{
  for(const ranges of [row('21:00 - 22:15',c.artist)+row('22:10 - 22:50',c.artist),row('21:00 - 21:55',c.artist)+row('21:00 - 22:50',c.artist)]){
    const s=merged(page(ranges));assert.equal(s.main.time,null);assert.equal(s.end.time,null);assert.equal(s.main.sets,undefined);
  }
  const s=merged(page(rows,'Tijden','<p>Example Band: 20:45</p>'));
  assert.equal(s.main.time,null);assert.equal(s.main.sets,undefined);
  const plain=parsed(`<main><h1>${c.artist}</h1><time datetime="${c.date}"></time><p>Example Band: 21:00</p><p>Example Band: 22:10</p></main>`);
  assert.equal(plain.values.main,undefined);assert.ok(plain.conflicts.includes('main'));
});

test('013 repeated desktop/mobile lists are deduplicated without inventing extra sets',()=>{
  const s=merged(page(rows)+page(rows));assert.equal(s.main.sets.length,2);assert.equal(s.main.breaks.length,1);
});

test('013 failed refresh preserves sets; successful removal replaces them',()=>{
  const concert={...c,schedule:merged()},now='2026-11-03T14:00:00Z';
  const failed=mergeSchedule(concert,[],now,'manual');assert.equal(failed.main.sets.length,2);assert.equal(failed.end.time,'22:50');
  const fresh=parseSchedule(page(row('19:00','Zaal Open')),c,url,'official',now);
  const removed=mergeSchedule(concert,[fresh],now,'manual');assert.equal(removed.main.time,null);assert.equal(removed.main.sets,undefined);assert.equal(removed.end.time,null);
});

test('013 overnight sets preserve day offsets and resumption',()=>{
  const s=merged(page(row('23:00 - 23:55',c.artist)+row('23:55 - 00:10','Pauze')+row('00:10 - 00:50',c.artist)));
  assert.equal(s.main.time,'23:00');assert.equal(s.end.time,'00:50');assert.equal(s.end.dayOffset,1);
  assert.equal(s.main.sets[1].dayOffset,1);assert.equal(s.main.breaks[0].endDayOffset,1);
  assert.equal(scheduleCountdown({...c,schedule:s},Date.parse('2026-11-04T00:00:00+01:00')),'BREAK · EXAMPLE BAND RESUMES IN 10M');
});

test('013 wrong event identity and other publisher conflicts are not relaxed',()=>{
  assert.equal(parsed(page(rows).replaceAll(c.artist,'Other Band')),null);
  const other=parseSchedule(page(rows),c,'https://hall-fame.nl/programma/example','official',stamp);
  assert.equal(other.values.main,undefined);assert.ok(other.conflicts.includes('main'));
  const malformed={...merged(),main:{...merged().main,sets:[{time:'21:00',endTime:'21:55'},{time:'20:00',endTime:'22:50'}]}};
  assert.equal((scheduleMarkup({...c,schedule:malformed}).match(/data-schedule-kind="main"/g)||[]).length,1);
});

test('013 café opening before hall doors is not a support act and does not erase times',()=>{
  const show={...c,artist:'Nordic Giants',date:'2026-11-12',venue:'Little Devil'};
  const html=`<main><h1>Nordic Giants</h1><time datetime="2026-11-12">do 12 nov 2026</time>
    <div><div class="ribbon_basic">Tijden</div><ul>
      ${row('17:00','Café Open')}
      ${row('19:15','Zaal Open')}
      ${row('19:45 - 20:30','L.O.E.')}
      ${row('21:00 - 22:00','Nordic Giants')}
    </ul></div></main>`;
  const result=parseSchedule(html,show,'https://www.013.nl/programma/141473/nordic-giants','official',stamp);
  assert.ok(result);
  const s=mergeSchedule(show,[result],stamp,'manual');
  assert.equal(s.doors.time,'19:15');
  assert.equal(s.main.time,'21:00');
  assert.equal(s.end.time,'22:00');
  assert.deepEqual(s.support.map(x=>[x.name,x.time]),[['L.O.E.','19:45']]);
  const old={...show,schedule:{...s,support:[{name:'Café Open',time:null,sourceUrl:'https://www.013.nl/programma/141473/nordic-giants'},...s.support]}};
  const refreshed=mergeSchedule(old,[result],stamp,'manual');
  assert.deepEqual(refreshed.support.map(x=>x.name),['L.O.E.']);
  const markup=scheduleMarkup({...show,schedule:{...refreshed,end:{name:'END',time:null}}});
  assert.ok(!markup.includes('Café Open'));
  assert.ok(!markup.includes('>END<'));
});
