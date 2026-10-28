import {resolveSetlist,extractSets,targetIdentity} from './setlist-resolver.mjs';
import {warmupArtistKey as key,referenceDate,referenceURL,validWarmupReference} from '../../js/warmup-setlist-model.js';
export async function resolveWarmupSetlist(c,artist,get,now=Date.now()) {
  const today=new Date(now).toISOString().slice(0,10);
  const reference=await resolveSetlist(c,artist,get,now);
  if(reference && validWarmupReference(reference,artist,today) && reference.sourceEvent.date<c.date)return reference;
  const cutoff=new Date(now-180*86400000).getUTCFullYear(),year=new Date(now).getUTCFullYear();
  const choices=new Map();
  for(const y of [...new Set([year,cutoff])])for(let p=1;p<=3;p++) {
    const u=new URL('https://api.setlist.fm/rest/1.0/search/setlists');
    for(const [name,value]of Object.entries({artistName:artist,year:y,p}))u.searchParams.set(name,String(value));
    const data=await get(u.href);if(data===null)break;
    if(!data||!Object.hasOwn(data,'setlist'))throw Error('Unexpected setlist response');
    const rows=[data.setlist].flat().filter(Boolean);
    for(const item of rows) {
      const date=referenceDate(item.eventDate);
      if(item.id && referenceURL(item.url) && key(item.artist?.name)===key(artist)
        && date && date<=today && Date.parse(date+'T12:00Z')>=now-181*86400000)choices.set(item.id,item);
    }
    if(!(Number(data.page)*Number(data.itemsPerPage)<Number(data.total)))break;
  }
  // Avoid choosing between different artists that share the same name.
  if(new Set([...choices.values()].map(i=>i.artist?.mbid).filter(Boolean)).size>1)return null;
  for(const candidate of [...choices.values()].sort((a,b)=>referenceDate(b.eventDate).localeCompare(referenceDate(a.eventDate))).slice(0,3)) {
    const item=extractSets(candidate).length?candidate:await get('https://api.setlist.fm/rest/1.0/setlist/'+encodeURIComponent(candidate.id));
    if(!item || item.id!==candidate.id)continue;
    const result={artist,sets:extractSets(item),matchType:'recent-reference',targetIdentity:targetIdentity(c,artist),
      sourceUrl:referenceURL(item.url),setlistFmId:item.id,tourEvidence:null,
      sourceEvent:{artist:item.artist?.name,date:referenceDate(item.eventDate),venue:item.venue?.name||'',city:item.venue?.city?.name||'',tour:item.tour?.name||''}};
    if(validWarmupReference(result,artist,today) && result.sourceEvent.date<c.date)return result;
  }
  return null;
}
