import {normalizeArtistName} from '../sources/podiuminfo.mjs';

// Strict per-edition identity. We cannot merge by band alone; two different
// festivals can share a venue, date or headliner.
export const officialEditionKey=e=>[
  normalizeArtistName(e?.festivalName||e?.artist),
  String(e?.date||'').slice(0,4),
  normalizeArtistName(e?.city),String(e?.country||'').toUpperCase()
].join('|');

export function mergeOfficialFestivalEvents(events,officialEvents,festivalCache) {
  const merged=[...events],known=Object.values(festivalCache?.editions||{})
    .map(x=>x?.event).filter(e=>e?.source==='festivalinfo'&&e.isFestival&&!e.cancelled);
  const stats={added:0,enriched:0,deduplicated:0};
  for(const official of officialEvents){
    const edition=officialEditionKey(official);
    if(!official.isFestival||!edition||!official.matchedTracked?.length)continue;
    const matchedIndexes=merged.flatMap((e,i)=>e?.isFestival
      &&officialEditionKey(e)===edition?[i]:[]);
    const matching=matchedIndexes.map(i=>merged[i]);
    const matchedCache=known.find(e=>officialEditionKey(e)===edition);
    // If Festivalinfo already assigned the edition ID, preserve it across
    // source changes. This preserves Going/Set aside history and avoids duplicates.
    const primary=matching.find(e=>e.source==='festivalinfo')
      ||matchedCache||matching[0]||null;
    const updated=primary?{
      ...primary,
      lineup:official.lineup,matchedTracked:official.matchedTracked,
      date:official.date,endDate:official.endDate,
      officialUrl:official.officialUrl,
      sourceApis:[...new Set([...(primary.sourceApis||[primary.source]),'officialfestival'])],
      ...(primary.source==='festivalinfo'?{
        source:'festivalinfo',concertId:primary.concertId,
        url:primary.url
      }:{})
    }:{...official};
    if(matchedIndexes.length){
      const first=matchedIndexes[0];merged[first]=updated;
      for(const idx of matchedIndexes.slice(1).reverse()){merged.splice(idx,1);stats.deduplicated++;}
      stats.enriched++;
    }else if(matchedCache){
      merged.push(updated);stats.added++;
    }else{
      merged.push(updated);stats.added++;
    }
  }
  return {events:merged,stats};
}
