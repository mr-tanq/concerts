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
    id:'latest',artist:'Band',date:'2026-05-01',
    venue:'Hall B',city:'City B',seenArtists:['Band']
  },
  {
    id:'first',artist:'Main',date:'2020-01-01',
    venue:'Hall A',city:'City A',seenArtists:['Main','Band']
  },
  {
    id:'missed',artist:'Main',date:'2010-01-01',
    venue:'Hall C',city:'City C',
    lineup:['Main','Band'],seenArtists:['Main']
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
    fullDate:date=>date,yearOf:date=>date.slice(0,4),
    archiveEntry:c=>el(`<article>${esc(c.id)}</article>`)
  });
  const flatten=node=>node.html+node.children.map(flatten).join('');
  return flatten(host);
}

test('artist profile includes seen support slots but excludes missed artists',()=>{
  const html=render({mode:'artist',value:'Band'});
  assert.match(html,/Band · 2 times seen/);
  assert.match(html,/<b>2<\/b> rooms ·\s*<b>2<\/b> cities/);
  assert.match(html,/First time: 2020-01-01 · Hall A, City A/);
  assert.match(html,/Most recent: 2026-05-01 · Hall B, City B/);
  assert.doesNotMatch(html,/Hall C|<article>missed/);
});

test('a single appearance does not duplicate first and latest',()=>{
  const html=render({mode:'artist',value:'Band'},[shows[0]]);
  assert.match(html,/Band · 1 time seen/);
  assert.match(html,/Seen on: 2026-05-01/);
  assert.doesNotMatch(html,/First time:|Most recent:/);
  assert.match(html,/<b>1<\/b> room ·\s*<b>1<\/b> city/);
});

test('artist variants are matched without reordering the source archive',()=>{
  const concerts=[...shows];
  const before=concerts.map(c=>c.id);
  const html=render({mode:'artist',value:'BAND'},concerts);
  assert.match(html,/2 times seen/);
  assert.deepEqual(concerts.map(c=>c.id),before);
});

test('no seen appearances produce the normal empty state',()=>{
  const html=render({mode:'artist',value:'Unknown'});
  assert.match(html,/Nothing here/);
  assert.doesNotMatch(html,/archive-artist-summary/);
});

test('artist, venue and city text is escaped',()=>{
  const html=render({mode:'artist',value:'<Band>'},[{
    ...shows[0],seenArtists:['<Band>'],venue:'<Hall>',city:'<City>'
  }]);
  assert.match(html,/&lt;Band&gt;/);
  assert.match(html,/&lt;Hall&gt;/);
  assert.match(html,/&lt;City&gt;/);
  assert.doesNotMatch(html,/<Band>|<Hall>|<City>/);
});

test('year and all modes do not acquire artist profiles',()=>{
  assert.doesNotMatch(
    render({mode:'all',value:null}),/archive-artist-summary/
  );
  const html=render({mode:'year',value:'2026'});
  assert.match(html,/archive-year-summary/);
  assert.doesNotMatch(html,/archive-artist-summary/);
});
