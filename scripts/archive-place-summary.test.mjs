import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {buildArchiveView,filterConcerts} from '../js/archive-stats.js';

const app=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const start=app.indexOf('function archiveYearSummary(');
const code=app.slice(start,app.indexOf('function archiveEntry(',start));
const esc=s=>String(s??'')
  .replaceAll('&','&amp;').replaceAll('<','&lt;')
  .replaceAll('>','&gt;').replaceAll('"','&quot;');

const shows=[
  {
    id:'late',artist:'Main',date:'2026-05-01',
    venue:'Poppodium 013',city:'City A',
    lineup:['Main','Missed'],seenArtists:['Main']
  },
  {
    id:'first',artist:'Main',date:'2020-01-01',
    venue:'013',city:'City A',seenArtists:['Main','Support']
  },
  {
    id:'elsewhere',artist:'Other',date:'2010-01-01',
    venue:'Other Hall',city:'City B',seenArtists:['Other']
  }
];

function render(filter,concerts=shows) {
  const el=html=>({
    html,children:[],
    appendChild(node){this.children.push(node);}
  });
  const host=el('');
  vm.runInNewContext(code+'\nrenderSpine();',{
    el,esc,buildArchiveView,filterConcerts,
    archiveConcerts:concerts,exploreFilter:filter,
    document:{getElementById:()=>host},
    fullDate:date=>date,yearOf:date=>date.slice(0,4),
    archiveEntry:c=>el(`<article>${esc(c.id)}</article>`)
  });
  const flatten=node=>node.html+node.children.map(flatten).join('');
  return flatten(host);
}

test('city summary counts selected shows, seen artists and canonical rooms',()=>{
  const html=render({mode:'city',value:'City A'});
  assert.match(html,/City A · 2 shows/);
  assert.match(html,/<b>2<\/b> artists/);
  assert.match(html,/<b>3<\/b> performances/);
  assert.match(html,/<b>1<\/b> room/);
  assert.match(html,/First visit: 2020-01-01 · 013, City A/);
  assert.match(html,/Most recent: 2026-05-01/);
  assert.match(html,/Most often: <b>Main<\/b>, 2 times/);
  assert.doesNotMatch(html,/Other Hall|<article>elsewhere/);
});

test('venue aliases and venue families keep all matching rooms',()=>{
  assert.match(render({mode:'venue',value:'013'}),/013 · 2 shows/);
  const concerts=[
    {...shows[0],venue:'Stage B',venueFamily:'Building'},
    {...shows[1],venue:'Stage A',venueFamily:'Building'}
  ];
  const html=render({mode:'venue',value:'Building'},concerts);
  assert.match(html,/Building · 2 shows/);
  assert.match(html,/<b>1<\/b> city/);
  assert.match(html,/Stage A/);
  assert.match(html,/Stage B/);
});

test('one visit does not repeat dates or invent a most-seen artist',()=>{
  const html=render({mode:'city',value:'City B'});
  assert.match(html,/1 show</);
  assert.match(html,/Visited on: 2010-01-01/);
  assert.doesNotMatch(html,/First visit:|Most recent:|Most often:/);
});

test('ties above one appearance name every leading artist',()=>{
  const concerts=shows.slice(0,2).map(c=>({
    ...c,seenArtists:['Alpha','Beta']
  }));
  const html=render({mode:'city',value:'City A'},concerts);
  assert.match(html,/Most often: <b>Alpha, Beta<\/b>, 2 times each/);
});

test('empty location and unrelated modes keep their existing states',()=>{
  const empty=render({mode:'city',value:'Missing'});
  assert.match(empty,/Nothing here/);
  assert.doesNotMatch(empty,/archive-place-summary/);
  for(const filter of [
    {mode:'all',value:null},
    {mode:'year',value:'2026'},
    {mode:'artist',value:'Main'}
  ]) assert.doesNotMatch(render(filter),/archive-place-summary/);
});

test('location and artist labels are escaped',()=>{
  const html=render({mode:'city',value:'<City>'},
    shows.slice(0,2).map(c=>({
      ...c,city:'<City>',venue:'<Hall>',seenArtists:['<Artist>']
    }))
  );
  assert.match(html,/&lt;City&gt;/);
  assert.match(html,/&lt;Hall&gt;/);
  assert.match(html,/&lt;Artist&gt;/);
  assert.doesNotMatch(html,/<City>|<Hall>|<Artist>/);
});
