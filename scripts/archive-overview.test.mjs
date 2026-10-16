import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {getOverview,buildArchiveView} from '../js/archive-stats.js';

const show=(extra={})=>({
  artist:'Main',date:'2026-01-01',
  venue:'Hall',city:'City',...extra
});

test('separates concert count, unique artists and repeat performances',()=>{
  const r=getOverview([
    show({seenArtists:['Main','Support']}),
    show({date:'2026-02-01',seenArtists:['Main']})
  ]);
  assert.equal(r.totalConcerts,2);
  assert.equal(r.uniqueArtists,2);
  assert.equal(r.artistAppearances,3);
  assert.equal(r.reviewedConcerts,2);
});

test('missed festival and support artists do not inflate statistics',()=>{
  const r=getOverview([show({
    isFestival:true,artist:'Festival',
    lineup:['Main','Support','Missed'],
    seenArtists:['Main','Support']
  })]);
  assert.equal(r.festivals,1);
  assert.equal(r.uniqueArtists,2);
  assert.equal(r.artistAppearances,2);
});

test('case and accent variants count once per artist per concert',()=>{
  const r=getOverview([
    show({seenArtists:['MONO','Mono','Hāllas','Hallas']}),
    show({seenArtists:['mono','Hällas']})
  ]);
  assert.equal(r.uniqueArtists,2);
  assert.equal(r.artistAppearances,4);
});

test('explicit empty selections stay empty; unreviewed lineups are distinguished',()=>{
  const r=getOverview([
    show({seenArtists:[],lineup:['Missed']}),
    show({lineup:['Main','Support']})
  ]);
  assert.equal(r.totalConcerts,2);
  assert.equal(r.uniqueArtists,2);
  assert.equal(r.artistAppearances,2);
  assert.equal(r.reviewedConcerts,1);
  const empty=getOverview([]);
  assert.equal(empty.uniqueArtists,0);
  assert.equal(empty.artistAppearances,0);
});

const app=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const start=app.indexOf('function openingStatement(');
const code=app.slice(start,app.indexOf('// The single most affecting',start));
const esc=s=>String(s??'')
  .replaceAll('&','&amp;')
  .replaceAll('<','&lt;')
  .replaceAll('>','&gt;');

function render(concerts) {
  const context={
    view:buildArchiveView(concerts),el:html=>({html}),esc,
    yearOf:d=>d?.slice(0,4),
    titleCase:s=>s,spell:n=>String(n)
  };
  return vm.runInNewContext(code+'\nopeningStatement(view).html',context);
}

test('overview renders counts and explains legacy lineup assumptions',()=>{
  const html=render([show({lineup:['Main','Support']})]);
  assert.match(html,/<b>2<\/b> artists/);
  assert.match(html,/<b>2<\/b> performances/);
  assert.match(html,/0 of 1 shows/);
  assert.match(html,/Other shows use their listed lineup/);
  assert.match(html,/<details/);
});

test('fully reviewed overview omits the unreviewed message and escapes artist names',()=>{
  const html=render([show({seenArtists:['<script>']})]);
  assert.match(html,/1 of 1 shows/);
  assert.doesNotMatch(html,/Other shows use/);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>/);
});
