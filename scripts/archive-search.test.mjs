import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {
  searchArchiveConcerts,filterConcerts,buildArchiveView
} from '../js/archive-stats.js';

const concerts=[
  {
    id:'utrecht',artist:'MONO',date:'2026-01-01',
    venue:'TivoliVredenburg',city:'Utrecht',country:'NL',
    seenArtists:['MONO','Hāllas']
  },
  {
    id:'melkweg',artist:'Mono',date:'2025-11-12',
    venue:'Melkweg',city:'Amsterdam',country:'Netherlands',
    seenArtists:['Mono']
  },
  {
    id:'festival',artist:'Festival',festivalName:'Test Festival',
    isFestival:true,date:'2025-06-01',venue:'dB’s',
    city:'Utrecht',country:'NL',
    lineup:['Main','Missed'],seenArtists:['Main']
  },
  {
    id:'aliases',artist:'Μωρά Στη Φωτιά',date:'2024-01-01',
    venue:'013',venueFamily:'Building',city:'Tilburg',country:'NL',
    seenArtists:['Μωρά Στη Φωτιά']
  }
];
const ids=list=>list.map(c=>c.id);

test('words can match different fields and every word is required',()=>{
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'mono utrecht')),['utrecht']);
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'2025 Melkweg')),['melkweg']);
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'mono tilburg')),[]);
});

test('search ignores case, accents and apostrophe variants',()=>{
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'HALLAS')),['utrecht']);
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'dbs')),['festival']);
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'μωρα φωτια')),['aliases']);
});

test('known venue aliases and families can be searched',()=>{
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'Poppodium 013')),['aliases']);
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'Building')),['aliases']);
});

test('city filters match a selected city within a qualified location name',()=>{
  const locations=[
    {...concerts[0],city:'Utrecht Centrum'},
    concerts[1]
  ];
  assert.deepEqual(ids(filterConcerts(locations,{mode:'city',value:'Utrecht'})),['utrecht']);
});

test('festival names and seen support acts are searchable',()=>{
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'test festival')),['festival']);
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'Hāllas Utrecht')),['utrecht']);
  assert.deepEqual(ids(searchArchiveConcerts(concerts,'Missed')),[]);
});

test('empty queries restore everything without changing the archive',()=>{
  const before=JSON.stringify(concerts);
  assert.equal(searchArchiveConcerts(concerts,'  '),concerts);
  searchArchiveConcerts(concerts,'mono');
  assert.equal(JSON.stringify(concerts),before);
});

const app=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const code=app.slice(
  app.indexOf('function renderExplore()'),
  app.indexOf('function archiveEntry(')
);
const esc=s=>String(s??'')
  .replaceAll('&','&amp;').replaceAll('<','&lt;')
  .replaceAll('>','&gt;').replaceAll('"','&quot;');

function setup() {
  function el(html) {
    const node={
      html,children:[],events:{},
      appendChild(child){this.children.push(child);},
      addEventListener(name,fn){this.events[name]=fn;},
      querySelector(){return this.modes;}
    };
    Object.defineProperty(node,'innerHTML',{
      set(value){this.html=value;this.children=[];}
    });
    if(html.startsWith('<div class="explore">')) {
      node.modes=el('<div class="explore-modes"></div>');
      node.children.push(node.modes);
    }
    return node;
  }

  const explore=el(''),spine=el('');
  const context=vm.createContext({
    el,esc,buildArchiveView,filterConcerts,searchArchiveConcerts,
    archiveConcerts:concerts,archiveView:buildArchiveView(concerts),
    exploreFilter:{mode:'all',value:null},archiveExploreQuery:'',
    document:{getElementById:id=>id==='explore-root'?explore:spine},
    normalizeKey:s=>String(s).toLowerCase(),
    venueSearchNames:s=>[s],
    yearOf:date=>date.slice(0,4),fullDate:date=>date,
    archiveEntry:c=>el(`<article>${c.id}</article>`)
  });
  vm.runInContext(code+'\nrenderExplore();',context);
  const flatten=node=>node.html+node.children.map(flatten).join('');
  const run=js=>vm.runInContext(js,context);
  return {context,explore,run,html:()=>flatten(spine),bar:()=>flatten(explore)};
}

test('searching filters the timeline (Enter in the palette)',()=>{
  const ui=setup();
  ui.run("setArchiveQuery('mono utrecht')");
  assert.match(ui.html(),/1 show found/);
  assert.match(ui.html(),/<article>utrecht/);
  assert.doesNotMatch(ui.html(),/<article>melkweg/);
  assert.match(ui.bar(),/archive-chip/);
});

test('clearing the search restores all entries',()=>{
  const ui=setup();
  ui.run("setArchiveQuery('missing')");
  assert.match(ui.html(),/Nothing here/);
  ui.run("setArchiveQuery('')");
  for(const c of concerts)
    assert.match(ui.html(),new RegExp('<article>'+c.id));
  assert.doesNotMatch(ui.bar(),/archive-chip/);
});

test('choosing a palette group value replaces the text query',()=>{
  const ui=setup();
  ui.run("setArchiveQuery('mono')");
  const year=concerts.find(c=>c.id==='festival').date.slice(0,4);
  ui.run(`setArchiveFilter('year','${year}')`);
  assert.equal(ui.context.archiveExploreQuery,'');
  assert.equal(ui.context.exploreFilter.mode,'year');
  assert.match(ui.html(),/<article>festival/);
  assert.match(ui.bar(),/Year/);
});

test('search text is escaped in the result count and the chip',()=>{
  const ui=setup();
  ui.run("setArchiveQuery('<script>')");
  assert.match(ui.html(),/0 shows found/);
  assert.match(ui.html(),/&lt;script&gt;/);
  assert.doesNotMatch(ui.html()+ui.bar(),/<script>/);
});
