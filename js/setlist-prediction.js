import {warmupArtistKey,referenceDate,referenceURL,validWarmupReference} from './warmup-setlist-model.js';

// Observed play frequency in other concerts, NOT the probability a song
// will be played at the target concert. Never infer a future running order.
export function buildSetlistGuide(entry,artist,today,targetDate) {
  const raw=Array.isArray(entry?.references)&&entry.references.length ? entry.references : entry?[entry]:[];
  const dedup=new Map();
  for(const ref of raw) {
    if(!validWarmupReference(ref,artist,today,Infinity))continue;
    const date=referenceDate(ref.sourceEvent.date);
    if(!date || (targetDate&&date>=targetDate))continue;
    const url=referenceURL(ref.sourceUrl);
    const key=ref.setlistFmId||url;
    if(!dedup.has(key))dedup.set(key,ref);
  }
  const sources=[...dedup.values()].sort((a,b)=>b.sourceEvent.date.localeCompare(a.sourceEvent.date)).slice(0,5);
  const age=date=>Math.round((Date.parse(today+'T12:00Z')-Date.parse(date+'T12:00Z'))/86400000);
  const fresh=sources.filter(ref=>age(ref.sourceEvent.date)<=180);
  // Keep an old example visible for transparency but never promote it to a prediction.
  const evidence=fresh.length?fresh:sources.slice(0,1);
  const counts=new Map();
  for(const [showIndex,ref] of evidence.entries()) {
    const seen=new Set();
    let order=0;
    for(const set of ref.sets||[])for(const rawName of set.songs||[]) {
      const name=String(rawName||'').trim(),key=warmupArtistKey(name);
      if(!key||seen.has(key))continue;
      seen.add(key);
      const prior=counts.get(key)||{name,count:0,orderSum:0,lastSeen:-1};
      prior.count++;
      prior.orderSum+=order++;
      if(prior.lastSeen<0)prior.lastSeen=showIndex;
      counts.set(key,prior);
    }
  }
  const songs=[...counts.values()].map(s=>({
    name:s.name,count:s.count,total:evidence.length,
    observed:s.count+'/'+evidence.length+' shows',
    order:s.orderSum/s.count,lastSeen:s.lastSeen
  })).sort((a,b)=>b.count-a.count||a.lastSeen-b.lastSeen||a.order-b.order||a.name.localeCompare(b.name));
  return {
    sources:evidence,songs,
    stale:!!evidence.length&&!fresh.length,
    limited:evidence.length<3,
    festivalMix:evidence.some(ref=>ref.sourceEvent?.isFestival),
    showCount:evidence.length,
    lastDate:evidence[0]?.sourceEvent?.date||null
  };
}
