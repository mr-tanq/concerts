import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exactEvent,selectExactEvent,resolveSetlist
} from './lib/setlist-resolver.mjs';

const c={
  artist:'Band',date:'2026-10-10',
  venue:'Parent',city:'City',country:'Netherlands'
};
const item=(id,city='City',venue='Stage 1',country='NL')=>({
  id,url:`https://www.setlist.fm/setlist/${id}.html`,
  artist:{name:'Band'},eventDate:'10-10-2026',
  venue:{name:venue,city:{name:city,country:{code:country}}},
  sets:{set:[{song:[{name:'Song'}]}]}
});
const now=Date.parse('2026-10-16');

test('unique band-day-country match ignores different venue and city spelling',async()=>{
  const r=await resolveSetlist(c,'Band',
    async()=>({setlist:[item('one','Other spelling')]}),now);
  assert.equal(r.matchType,'exact');
  assert.equal(r.matchingVersion,5);
});

test('unknown and wrong countries cannot pass',()=>{
  assert.equal(exactEvent({...c,country:''},'Band',item('one')),false);
  assert.equal(exactEvent(c,'Band',
    item('one','City','Stage 1','BE')),false);
  const i=item('one');
  delete i.venue.city.country;
  assert.equal(exactEvent(c,'Band',i),false);
  assert.ok(exactEvent(
    {...c,country:'',countryCode:'NL'},'Band',item('one')));
});

test('city resolves multiple same-day concerts; venue resolves multiple halls',()=>{
  assert.equal(selectExactEvent(c,'Band',[
    item('one'),item('two','Other')
  ]).id,'one');
  assert.equal(selectExactEvent(c,'Band',[
    item('one','City','Parent'),item('two')
  ]).id,'one');
  assert.equal(selectExactEvent(c,'Band',[
    item('one'),item('two')
  ]),null);
  assert.equal(selectExactEvent(c,'Band',[
    item('one'),item('one')
  ]).id,'one');
});

test('country-only search collects all pages before deciding',async()=>{
  const requests=[];
  const r=await resolveSetlist(c,'Band',async url=>{
    const u=new URL(url);
    requests.push(u);
    const p=Number(u.searchParams.get('p'));
    return {
      setlist:[p===1 ? item('other','Other') : item('right')],
      page:p,itemsPerPage:1,total:2
    };
  },now);
  assert.equal(r.setlistFmId,'right');
  assert.equal(requests.length,2);
  for(const u of requests) {
    assert.equal(u.searchParams.get('countryCode'),'NL');
    assert.equal(u.searchParams.has('cityName'),false);
  }
});

test('incomplete pagination and detail identity changes are errors',async()=>{
  await assert.rejects(resolveSetlist(c,'Band',async()=>({
    setlist:[item('one')],page:1,itemsPerPage:1,total:100
  }),now));
  const empty=item('one');
  empty.sets={set:[]};
  await assert.rejects(resolveSetlist(c,'Band',async url=>{
    if(new URL(url).pathname.includes('/setlist/'))
      return item('one','City','Stage 1','BE');
    return {setlist:[empty]};
  },now));
});

test('ambiguous exact nights do not become tour references',async()=>{
  const r=await resolveSetlist({...c,tourName:'Tour'},'Band',
    async()=>({setlist:[item('one'),item('two')]}),now);
  assert.equal(r,null);
});
