import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {
  resolveSetlist,shouldCheckSetlist,targetIdentity
} from './lib/setlist-resolver.mjs';

const now=Date.parse('2026-10-16');
const c={
  id:'one',artist:'Band',date:'2023-11-01',
  venue:'Hall',city:'City',country:'NL'
};
const show=(id,date,artist='Band')=>({
  id,eventDate:date,artist:{name:artist},
  url:`https://www.setlist.fm/setlist/${id}.html`,
  venue:{
    name:'Other Hall',
    city:{name:'Other City',country:{code:'DE'}}
  },
  tour:{name:'Tour'},
  sets:{set:[{song:[{name:'Song'}]}]}
});
function api(items,exact=null,calls=[]) {
  return async url=>{
    const u=new URL(url);
    calls.push(u);
    if(u.pathname.includes('/setlist/')) return exact;
    return {
      setlist:u.searchParams.has('year')
        ? items : exact ? [exact] : []
    };
  };
}

test('missing target event can use a nearby show, explicitly unconfirmed',async()=>{
  const r=await resolveSetlist(c,'Band',
    api([show('near','31-10-2023')]),now);
  assert.equal(r.matchType,'similar-show');
  assert.equal(r.sourceEvent.date,'2023-10-31');
  assert.equal(r.tourEvidence.confirmed,false);
  assert.equal(r.tourEvidence.kind,'nearby-date');
});

test('closest eligible show wins; wrong artists, future and distant dates fail',async()=>{
  const items=[
    show('wrong','31-10-2023','Other'),
    show('far','01-10-2023'),
    show('later','07-11-2023'),
    show('nearest','31-10-2023')
  ];
  const r=await resolveSetlist(c,'Band',api(items),now);
  assert.equal(r.setlistFmId,'nearest');
  assert.equal(await resolveSetlist(c,'Band',
    api([show('future','17-10-2026')]),now),null);
  assert.equal(await resolveSetlist(c,'Band',
    api([show('far','01-10-2023')]),now),null);
});

test('exact day remains first choice and avoids nearby searches',async()=>{
  const exact=show('exact','01-11-2023');
  exact.venue.city.country.code='NL';
  const calls=[];
  const r=await resolveSetlist(c,'Band',
    api([show('near','31-10-2023')],exact,calls),now);
  assert.equal(r.matchType,'exact');
  assert.ok(calls.every(u=>!u.searchParams.has('year')));
});

test('known target tour never falls back to an unrelated tour',async()=>{
  const r=await resolveSetlist({...c,tourName:'Known Tour'},'Band',
    api([show('other','31-10-2023')]),now);
  assert.equal(r,null);
});

test('year boundaries search both years',async()=>{
  const calls=[];
  const r=await resolveSetlist({...c,date:'2024-01-01'},'Band',
    api([show('near','31-12-2023')],null,calls),now);
  assert.equal(r.setlistFmId,'near');
  assert.deepEqual(
    calls.filter(u=>u.searchParams.has('year'))
      .map(u=>u.searchParams.get('year')),
    ['2023','2024']
  );
});

test('support artists get their own nearby matches',async()=>{
  const r=await resolveSetlist(c,'Support',api([
    show('main','31-10-2023'),
    show('support','30-10-2023','Support')
  ]),now);
  assert.equal(r.artist,'Support');
  assert.equal(r.setlistFmId,'support');
});

test('API errors propagate and nearby retries become due daily',async()=>{
  await assert.rejects(resolveSetlist(c,'Band',async url=>{
    if(new URL(url).searchParams.has('year')) throw Error('HTTP 429');
    return null;
  },now));
  const previous={
    matchingVersion:5,targetIdentity:targetIdentity(c,'Band'),
    matchType:'similar-show',sets:[{}],lastExactCheckAt:'2026-10-14'
  };
  assert.ok(shouldCheckSetlist(previous,c,'Band',now));
  assert.equal(shouldCheckSetlist({
    ...previous,lastExactCheckAt:'2026-10-16'
  },c,'Band',now),false);
});

const source=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const start=source.indexOf('function renderSetlist(');
const code=source.slice(start,
  source.indexOf('// ==========================================================================',start));

function render(result) {
  const el=html=>({
    html,children:[],
    appendChild(child){this.children.push(child);},
    addEventListener(){}
  });
  const host=el('');
  vm.runInNewContext(code+'\nrenderSetlist(host,c);',{
    host,c,setlists:new Map([[c.id,{artists:{band:result}}]]),
    actuallySeenArtistsOf:()=>['Band'],
    normalizeKey:s=>s.toLowerCase(),
    esc:s=>String(s??''),el,URL,window:{open(){}}
  });
  const flatten=node=>node.html+node.children.map(flatten).join('');
  return flatten(host);
}

test('similar-show UI states uncertainty and actual source; no same-tour claim',async()=>{
  const r=await resolveSetlist(c,'Band',
    api([show('near','31-10-2023')]),now);
  const html=render(r);
  assert.match(html,/Similar show · nearby date/);
  assert.match(html,/tour for your concert is unconfirmed/);
  assert.match(html,/2023-10-31/);
  assert.match(html,/Other Hall/);
  assert.match(html,/Source: setlist.fm/);
  assert.doesNotMatch(html,/Same tour|What Band played/);
});

test('already verified exact version-4 results do not need another lookup',()=>{
  const previous={
    matchingVersion:4,targetIdentity:targetIdentity(c,'Band'),
    matchType:'exact',sets:[{}]
  };
  assert.equal(shouldCheckSetlist(previous,c,'Band',now),false);
});

test('empty nearby listings cannot hide a populated setlist',async()=>{
  const empty=[1,2,3,4].map(n=>{
    const s=show('empty'+n,`${String(n).padStart(2,'0')}-11-2023`);
    s.sets={set:[]};
    return s;
  });
  const r=await resolveSetlist(c,'Band',
    api([...empty,show('played','07-11-2023')]),now);
  assert.equal(r.setlistFmId,'played');
});
