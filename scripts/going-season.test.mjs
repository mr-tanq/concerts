import test from 'node:test';
import assert from 'node:assert/strict';
import { seasonSummary, listeningWindow } from '../js/going-season.js';

test('counts shows separately from dates and never treats a ticket as time off', () => {
  const data = [
    {date:'2026-11-01', practical:{ticketBought:true}},
    {date:'2026-11-01'},
    {date:'2026-11-02', workArrangement:{kind:'freeDay',status:'yes'}},
    {date:'2026-11-03', workArrangement:{kind:'lateStart',status:'yes'}}
  ];
  const s = seasonSummary(data, () => ({label:'1st night'}));
  assert.equal(s.shows, 4); assert.equal(s.nights, 3);
  assert.equal(s.booked, 1); assert.equal(s.work, 4); assert.equal(s.arranged, 1);
  assert.deepEqual(s.months, [{month:'2026-11',booked:1,planned:1,work:2,total:4}]);
});

test('listening counts use only the declared recorded weeks, including zero weeks', () => {
  const data = {meta:{weekStarts:['2026-09-01','2026-09-08','2026-09-15','2027-01-01']},
    artists:{'HÄLLAS':{name:'Hällas',weeks:{'2026-09-01':100,'2026-09-15':3,'2027-01-01':50}}}};
  const w = listeningWindow(data,'2026-10-21',2);
  assert.deepEqual(w.weeks,['2026-09-08','2026-09-15']);
  assert.equal(w.plays('Hallas'),3); assert.equal(w.plays('Unknown'),0);
  assert.equal(listeningWindow({},'2026-10-21'),null);
});
