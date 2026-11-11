import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {festivalLineupRevisit,canShowFestivalRevisit,sameFestivalUpdate} from '../js/festival-revisit-model.js';

const id='rec-festivalinfo-36695';
const dismissal={id,source:'festivalinfo',sourceId:'36695',isFestival:true,
  festivalName:'Roadburn',date:'2027-04-15',
  lineup:['Neurosis','Emma Ruth Rundle'],dismissedAt:'2026-11-01T12:00:00Z'};
const festival={source:'festivalinfo',concertId:'36695',isFestival:true,date:'2027-04-15',
  lineup:['Neurosis','Emma Ruth Rundle','MONO','Tool','New Unknown Band']};
const signals=new Map([['mono',{playcount:1000}],['tool',{playcount:100}],
  ['new unknown band',{playcount:3}],['neurosis',{playcount:500}]]);
const asRecommendation=update=>({id,source:'festivalinfo',isFestival:true,
  lineup:festival.lineup,festivalUpdate:update});
const history=({dismissed=[dismissal],plannedIds=[]}={})=>({
  dismissedIds:[id],dismissed,plannedIds
});

test('new favorite bands on a confirmed edition bring a passed festival back',()=>{
  const result=festivalLineupRevisit(festival,dismissal,signals,5);
  assert.deepEqual(result.newMatchingArtists,['MONO','Tool']);
  assert.equal(result.kind,'new-liked-artist');
  assert.equal(result.dismissedAt,dismissal.dismissedAt);
  assert.equal(canShowFestivalRevisit(asRecommendation(result),history()),true);
});
test('adding only unlistened, weakly listened or merely similar bands does not resurface',()=>{
  assert.equal(festivalLineupRevisit({...festival,lineup:[...dismissal.lineup,'New Unknown Band']},dismissal,signals),null);
  assert.equal(festivalLineupRevisit({...festival,lineup:[...dismissal.lineup,'Similar Only']},dismissal,signals),null);
  assert.equal(festivalLineupRevisit({...festival,lineup:dismissal.lineup},dismissal,signals),null);
});
test('second Pass updates the baseline: no repeat until a genuinely new loved artist',()=>{
  const first=festivalLineupRevisit(festival,dismissal,signals);
  const secondDismissal={...dismissal,lineup:[...festival.lineup],dismissedAt:'2026-11-05T12:00:00Z'};
  assert.equal(canShowFestivalRevisit(asRecommendation(first),history({dismissed:[secondDismissal]})),false);
  assert.equal(festivalLineupRevisit(festival,secondDismissal,signals),null);
  const newEdition={...festival,lineup:[...festival.lineup,'Sigur Rós']};
  const fresh=festivalLineupRevisit(newEdition,secondDismissal,
    new Map([...signals,['sigur ros',{playcount:500}]]));
  assert.deepEqual(fresh.newMatchingArtists,['Sigur Rós']);
  assert.equal(canShowFestivalRevisit({...asRecommendation(fresh),lineup:newEdition.lineup},
    history({dismissed:[secondDismissal]})),true);
});
test('cannot return if already planned, historic dismissal missing, or snapshot outdated',()=>{
  const update=festivalLineupRevisit(festival,dismissal,signals);
  assert.equal(canShowFestivalRevisit(asRecommendation(update),history({plannedIds:[id]})),false);
  assert.equal(canShowFestivalRevisit(asRecommendation(update),history({dismissed:[]})),false);
  assert.equal(canShowFestivalRevisit({...asRecommendation(update),lineup:dismissal.lineup},history()),false);
  assert.equal(canShowFestivalRevisit({...asRecommendation(update),festivalUpdate:{...update,dismissedAt:'2001-01-01'}},history()),false);
});
test('never use cross-festival or stale wrong-year lineup as evidence',()=>{
  for(const bad of [
    {...festival,concertId:'not-36695'}, {...festival,source:'podiuminfo'},
    {...festival,isFestival:false},{...festival,date:'2028-04-15'}])
    assert.equal(festivalLineupRevisit(bad,dismissal,signals),null);
  assert.equal(festivalLineupRevisit(festival,{...dismissal,source:'podiuminfo'},signals),null);
  assert.equal(festivalLineupRevisit(festival,{...dismissal,lineup:[]},signals),null);
});
test('normalization avoids false additions from accent or case changes',()=>{
  const previous={...dismissal,lineup:['Sigur Rós','MONO']};
  const current={...festival,lineup:['sigur ros','mono']};
  assert.equal(festivalLineupRevisit(current,previous,signals),null);
});
test('repeated discovery retains first detection timestamp for identical updates',()=>{
  const same=festivalLineupRevisit(festival,dismissal,signals);
  assert.equal(sameFestivalUpdate(same,{...same,detectedAt:'2026-11-11'}),true);
  assert.equal(sameFestivalUpdate(same,{...same,newMatchingArtists:['MONO']}),false);
});
test('pipeline and swipe handlers support lineup re-review without bypassing normal history',()=>{
  const discover=readFileSync(new URL('./discover-concerts.mjs',import.meta.url),'utf8');
  const app=readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
  assert.match(discover,/festivalLineupRevisit\(event,previousDismissal,signalByName,minPlaycount\)/);
  assert.match(discover,/festivalUpdate:revisit/);
  assert.match(discover,/if \(isPlanned \|\|/);
  assert.match(app,/canShowFestivalRevisit\(c,historyData\)/);
  assert.match(app,/history\.dismissed=history\.dismissed\.filter\(d=>d\.id!==rec\.id\)/);
  assert.match(app,/newNames/);
  assert.match(app,/history\.dismissedIds=.*filter\(id=>id!==rec\.id\)/);
});
