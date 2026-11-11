// Live, read-only smoke check: the PR's synthetic fixtures cannot prove
// organisers haven't redesigned their website overnight.
import {discoverOfficialFestivals,OFFICIAL_FESTIVAL_EDITIONS} from './sources/official-festivals.mjs';
const result=await discoverOfficialFestivals({
  trackedArtistNames:['Neurosis','Paradise Lost','MONO','Emma Ruth Rundle'],
  startDate:'2027-01-01',endDate:'2027-12-31',
  countries:['NL','BE'],editions:OFFICIAL_FESTIVAL_EDITIONS,
  cache:{editions:{}},pause:async()=>{}
});
for(const entry of result.events)console.log(
  entry.festivalName,entry.date,
  'artists',entry.lineup.length,
  'matched',entry.matchedTracked.join(', ')
);
console.log('Official live source diagnostics:',JSON.stringify(result.stats));
const names=new Set(result.events.map(e=>e.festivalName));
if(!names.has('Roadburn')||!names.has('Graspop Metal Meeting')
   ||result.stats.verified!==2)throw Error('Live official festival source verification incomplete');
