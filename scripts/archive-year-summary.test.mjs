import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {buildArchiveView,filterConcerts,searchArchiveConcerts} from '../js/archive-stats.js';

const app=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const start=app.indexOf('function archiveYearSummary(');
const code=app.slice(start,app.indexOf('function archiveEntry(',start));
const esc=s=>String(s??'')
  .replaceAll('&','&amp;').replaceAll('<','&lt;')
  .replaceAll('>','&gt;').replaceAll('"','&quot;');

const shows=[
  {
    id:'a',artist:'Main',date:'2025-01-01',
    city:'City',venue:'Hall',seenArtists:['Main','Support']
  },
  {
    id:'b',artist:'Main',date:'2025-02-01',
    city:'City',venue:'Hall',
    lineup:['Main','Missed'],seenArtists:['Main']
  },
  {
    id:'c',artist:'Other',date:'2026-01-01',
    city:'Other City',venue:'Other Hall',seenArtists:['Other']
  }
];

function render(filter,concerts=shows) {
  const el=html=>({
    html,children:[],
    appendChild(node){this.children.push(node);}
  });
  const host=el('');
  vm.runInNewContext(code+'\nrenderSpine();',{
    el,esc,buildArchiveView,filterConcerts,searchArchiveConcerts,
    archiveConcerts:concerts,exploreFilter:filter,archiveExploreQuery:"",
    document:{getElementById:()=>host},
    yearOf:date=>date.slice(0,4),fullDate:date=>date,
    archiveEntry:c=>el(`<article>${esc(c.artist)}</article>`)
  });
  const flatten=node=>node.html+node.children.map(flatten).join('');
  return flatten(host);
}

test('selected year counts only its shows, seen artists and performances',()=>{
  const html=render({mode:'year',value:'2025'});
  assert.match(html,/2025 · 2 shows/);
  assert.match(html,/<b>2<\/b> artists/);
  assert.match(html,/<b>3<\/b> performances/);
  assert.match(html,/Most often: <b>Main<\/b>, 2 times/);
  assert.doesNotMatch(html,/Other City|<article>Other/);
});

test('another year replaces the summary and uses singular labels',()=>{
  const html=render({mode:'year',value:'2026'});
  assert.match(html,/2026 · 1 show/);
  assert.match(html,/<b>1<\/b> artist ·/);
  assert.doesNotMatch(html,/Most often:/);
  assert.doesNotMatch(html,/2025 · 2 shows/);
});

test('all and artist filters keep their existing layout',()=>{
  assert.doesNotMatch(
    render({mode:'all',value:null}),/archive-year-summary/
  );
  const html=render({mode:'artist',value:'Main'});
  assert.doesNotMatch(html,/archive-year-summary/);
  assert.match(html,/Main · 2 times seen/);
});

test('empty year has an empty state rather than invented statistics',()=>{
  const html=render({mode:'year',value:'1999'});
  assert.match(html,/Nothing here/);
  assert.doesNotMatch(html,/archive-year-summary/);
});

test('summary escapes artist text and respects missed lineups',()=>{
  const html=render({mode:'year',value:'2025'},[
    {...shows[0],artist:'<script>',seenArtists:['<script>']},
    {...shows[1],seenArtists:[]}
  ]);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/<b>1<\/b> performance/);
});

test('several artists seen once do not produce an arbitrary most-seen name',()=>{
  const html=render({mode:'year',value:'2025'},[
    {...shows[0],seenArtists:['Alpha','Beta']},
    {...shows[1],seenArtists:['Gamma']}
  ]);
  assert.doesNotMatch(html,/Most often:/);
});

test('tied repeat artists are all named and marked as tied',()=>{
  const html=render({mode:'year',value:'2025'},[
    {...shows[0],seenArtists:['Alpha','Beta','Once']},
    {...shows[1],seenArtists:['Alpha','Beta']}
  ]);
  assert.match(html,/Most often: <b>Alpha, Beta<\/b>, 2 times each/);
  assert.doesNotMatch(html,/Most often: <b>[^<]*Once/);
});
