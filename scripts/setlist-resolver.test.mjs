import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,mkdtemp,mkdir,writeFile,cp,rm
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {
  exactEvent,resolveSetlist,shouldCheckSetlist,targetIdentity
} from './lib/setlist-resolver.mjs';

const now=Date.parse('2026-10-16T12:00Z');
const c={
  id:'one',artist:'MONO',date:'2026-10-10',
  venue:'Paradiso',city:'Amsterdam',country:'NL'
};
const item=(id,date='10-10-2026',songs=['Song'])=>({
  id,eventDate:date,url:`https://www.setlist.fm/setlist/${id}.html`,
  artist:{name:'MONO'},
  venue:{name:'Paradiso',city:{name:'Amsterdam',country:{code:'NL'}}},
  tour:{name:'Oath Tour'},
  sets:{set:songs.length ? [{song:songs.map(name=>({name}))}] : []}
});
const search=items=>({
  setlist:items,page:1,itemsPerPage:20,total:items.length
});
const api=(anchor,options=[])=>async url=>{
  const u=new URL(url);
  if (u.pathname.includes('/setlist/')) return anchor;
  return search(u.searchParams.has('tourName')
    ? options : anchor ? [anchor] : []);
};

test('exact show takes priority over references',async()=>{
  const r=await resolveSetlist(c,'MONO',
    api(item('exact'),[item('other','09-10-2026')]),now);
  assert.equal(r.matchType,'exact');
  assert.equal(r.setlistFmId,'exact');
});

test('exact identity requires band, day and country; room and city are optional',()=>{
  assert.ok(exactEvent(c,'MONO',item('ok')));
  const room=item('room');
  room.venue.name='Stage 1';
  room.venue.city.name='Different spelling';
  assert.ok(exactEvent(c,'MONO',room));

  for (const edit of [
    i=>i.artist.name='Other',
    i=>i.eventDate='09-10-2026',
    i=>i.venue.city.country.code='BE',
    i=>delete i.venue.city.country
  ]) {
    const i=item('bad');
    edit(i);
    assert.equal(exactEvent(c,'MONO',i),false);
  }
});

test('reference needs proven tour and selects closest eligible night',async()=>{
  const wrong=item('wrong','09-10-2026');wrong.tour.name='Different';
  const future=item('future','17-10-2026');
  const r=await resolveSetlist(c,'MONO',
    api(item('anchor','10-10-2026',[]),[
      wrong,future,item('far','01-10-2026'),item('near','09-10-2026')
    ]),now);
  assert.equal(r.matchType,'tour-reference');
  assert.equal(r.setlistFmId,'near');
  assert.equal(r.sourceEvent.date,'2026-10-09');
  assert.equal(r.tourEvidence.id,'anchor');
});

test('no proof means no approximate setlist',async()=>{
  assert.equal(await resolveSetlist(c,'MONO',
    api(null,[item('other','09-10-2026')]),now),null);
  const a=item('empty','10-10-2026',[]);delete a.tour;
  assert.equal(await resolveSetlist(c,'MONO',
    api(a,[item('other','09-10-2026')]),now),null);
});

test('headliner tour does not leak into support lookup',async()=>{
  assert.equal(await resolveSetlist(
    {...c,tourName:'Oath Tour'},'Support',api(null),now),null);
  const r=await resolveSetlist({...c,tourName:'Oath Tour'},'MONO',
    api(null,[item('other','09-10-2026')]),now);
  assert.equal(r.matchType,'tour-reference');
  assert.equal(r.tourEvidence.kind,'concert-tour');
});

test('wrong tour, artist, far date and future references rejected',async()=>{
  for (const change of [
    i=>i.tour.name='Other',
    i=>i.artist.name='Other',
    i=>i.eventDate='01-01-2026',
    i=>i.eventDate='17-10-2026'
  ]) {
    const other=item('other','09-10-2026');change(other);
    assert.equal(await resolveSetlist(c,'MONO',
      api(item('anchor','10-10-2026',[]),[other]),now),null);
  }
});

test('API errors and malformed responses are not negative matches',async()=>{
  await assert.rejects(resolveSetlist(c,'MONO',
    async()=>{throw Error('429');},now));
  await assert.rejects(resolveSetlist(c,'MONO',
    async()=>({error:'broken'}),now));
  assert.equal(await resolveSetlist(c,'MONO',async()=>null,now),null);
  await assert.rejects(resolveSetlist(
    {...c,date:'2026-02-31'},'MONO',api(null),now));
});

test('changed detail identity is rejected',async()=>{
  await assert.rejects(resolveSetlist(c,'MONO',
    async url=>new URL(url).pathname.includes('/setlist/')
      ? item('wrong') : search([item('empty','10-10-2026',[])]),now));
});

test('references retry daily; legacy records revalidate; exact results are retained',()=>{
  const previous={
    matchingVersion:5,targetIdentity:targetIdentity(c,'MONO'),sets:[{}],
    lastExactCheckAt:'2026-10-14T12:00Z',matchType:'tour-reference'
  };
  assert.ok(shouldCheckSetlist(previous,c,'MONO',now));
  assert.equal(shouldCheckSetlist({
    ...previous,lastExactCheckAt:'2026-10-16T11:00Z'
  },c,'MONO',now),false);
  assert.equal(shouldCheckSetlist({
    ...previous,matchType:'exact'
  },c,'MONO',now),false);
  assert.ok(shouldCheckSetlist({sets:[{}]},c,'MONO',now));
});

const source=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const start=source.indexOf('function renderSetlist(');
const renderCode=source.slice(start,
  source.indexOf('// ==========================================================================',start));
const esc=value=>String(value ?? '')
  .replaceAll('&','&amp;').replaceAll('<','&lt;')
  .replaceAll('>','&gt;').replaceAll('"','&quot;');

function render(result,concert=c) {
  const el=html=>({
    html,children:[],
    appendChild(child){this.children.push(child);},
    addEventListener(){}
  });
  const host=el('');
  vm.runInNewContext(renderCode+'\nrenderSetlist(host,c);',{
    host,c:concert,
    setlists:new Map([[c.id,{artists:{mono:result}}]]),
    actuallySeenArtistsOf:()=>['MONO'],
    normalizeKey:s=>s.toLowerCase(),esc,el,URL,window:{open(){}}
  });
  const flatten=node=>node.html+node.children.map(flatten).join('');
  return flatten(host);
}

test('reference UI exposes provenance without claiming exact night',async()=>{
  const r=await resolveSetlist(c,'MONO',
    api(item('anchor','10-10-2026',[]),[item('other','09-10-2026')]),now);
  const html=render(r);
  assert.match(html,/≈/);
  assert.match(html,/<details/);
  assert.match(html,/2026-10-09/);
  assert.match(html,/Oath Tour/);
  assert.doesNotMatch(html,/What MONO played/);
  assert.match(html,/Source: setlist.fm/);
  assert.equal(render({...r,targetIdentity:'stale'}),'');
  assert.doesNotMatch(render({...r,sourceUrl:'javascript:alert(1)'}),/Source:/);
  assert.match(render({
    ...r,sourceEvent:{...r.sourceEvent,venue:'<script>'}
  }),/&lt;script&gt;/);
});

test('exact UI remains exact',async()=>{
  const r=await resolveSetlist(c,'MONO',api(item('exact')),now);
  assert.match(render(r),/What MONO played/);
  assert.doesNotMatch(render(r),/≈/);
});

async function runScript(failure, kind='tour-reference') {
  const root=await mkdtemp(path.join(tmpdir(),'mirror-setlists-'));
  try {
    for (const dir of ['scripts/lib','js','data'])
      await mkdir(path.join(root,dir),{recursive:true});
    for (const file of [
      'scripts/fetch-setlists.mjs',
      'scripts/lib/setlist-resolver.mjs',
      'js/concert-countries.js'
    ]) await cp(new URL('../'+file,import.meta.url),path.join(root,file));

    await writeFile(path.join(root,'package.json'),'{"type":"module"}');
    await writeFile(path.join(root,'data/archive.json'),
      JSON.stringify({concerts:[c]}));

    const old={
      artist:'MONO',sets:[{name:'Set',songs:['Old']}],
      matchType:kind,matchingVersion:5,
      targetIdentity:targetIdentity(c,'MONO'),
      checkedAt:'2026-01-01',lastExactCheckAt:'2026-01-01'
    };
    await writeFile(path.join(root,'data/setlists.json'),
      JSON.stringify({setlists:{one:{artists:{mono:old}}}}));

    await writeFile(path.join(root,'mock.mjs'),`
      globalThis.setTimeout=(fn)=>{queueMicrotask(fn);return 0;};
      globalThis.fetch=async()=>({
        status:${failure ? 500 : 200},ok:${!failure},
        json:async()=>(${JSON.stringify(search([item('exact')]))})
      });
      await import('./scripts/fetch-setlists.mjs');
    `);
    const child=spawnSync(process.execPath,['mock.mjs'],{
      cwd:root,
      env:{...process.env,SETLISTFM_API_KEY:'test',MAX_LOOKUPS:'1'},
      encoding:'utf8'
    });
    assert.equal(child.status,0,child.stderr);
    return JSON.parse(await readFile(
      path.join(root,'data/setlists.json'),'utf8'
    )).setlists.one.artists.mono;
  } finally {
    await rm(root,{recursive:true,force:true});
  }
}

test('fetch job retains previous reference on API failure',async()=>{
  const r=await runScript(true);
  assert.equal(r.matchType,'tour-reference');
  assert.equal(r.checkedAt,'2026-01-01');
  assert.equal(r.lastExactCheckAt,'2026-01-01');
  assert.ok(r.lastError);
  assert.equal(r.sets[0].songs[0],'Old');
});

test('fetch job automatically upgrades reference to exact',async()=>{
  const r=await runScript(false);
  assert.equal(r.matchType,'exact');
  assert.equal(r.setlistFmId,'exact');
  assert.equal(r.lastError,null);
});

test('fetch job upgrades a similar show to the exact night',async()=>{
  const r=await runScript(false,'similar-show');
  assert.equal(r.matchType,'exact');
  assert.equal(r.setlistFmId,'exact');
});
test('fetch job preserves similar-show provenance on API failure',async()=>{
  const r=await runScript(true,'similar-show');
  assert.equal(r.matchType,'similar-show');
  assert.ok(r.lastError);
});
