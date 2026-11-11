import {extractSets,targetIdentity} from './setlist-resolver.mjs';
import {warmupArtistKey as key,referenceDate,referenceURL,validWarmupReference} from '../../js/warmup-setlist-model.js';

// Inspect several verified, completed shows. A nearby concert or a festival
// appearance is evidence of what the artist played, never a promised setlist.
export async function resolveWarmupSetlist(c,artist,get,now=Date.now()) {
  const today=new Date(now).toISOString().slice(0,10);
  const cutoff=new Date(now-180*86400000).getUTCFullYear();
  const year=new Date(now).getUTCFullYear();
  const options=new Map();
  for(const y of [...new Set([year,cutoff])])for(let p=1;p<=3;p++) {
    const u=new URL('https://api.setlist.fm/rest/1.0/search/setlists');
    for(const [name,value]of Object.entries({artistName:artist,year:y,p}))u.searchParams.set(name,String(value));
    const data=await get(u.href);
    if(data===null)break;
    if(!data||!Object.hasOwn(data,'setlist'))throw Error('Unexpected setlist response');
    for(const item of [data.setlist].flat().filter(Boolean)) {
      const date=referenceDate(item.eventDate);
      if(!item.id||!referenceURL(item.url)||key(item.artist?.name)!==key(artist)
        ||!date||date>today||date>=c.date
        ||Date.parse(date+'T12:00Z')<now-181*86400000)continue;
      options.set(item.id,item);
    }
    if(!(Number(data.page)*Number(data.itemsPerPage)<Number(data.total)))break;
  }
  // A shared band name is not sufficient to merge different MusicBrainz IDs.
  if(new Set([...options.values()].map(i=>i.artist?.mbid).filter(Boolean)).size>1)return null;
  const all=[...options.values()].sort((a,b)=>
    referenceDate(b.eventDate).localeCompare(referenceDate(a.eventDate))
    ||String(a.id).localeCompare(String(b.id)));
  const targetTour=key(c.tourName||c.tour?.name||'');
  const matchingTour=targetTour?all.filter(i=>key(i.tour?.name)===targetTour):[];
  // If a tour is explicitly known, use it; otherwise prefer ordinary shows
  // for a non-festival date, when enough recent ones actually exist.
  let candidates=matchingTour.length?matchingTour:all;
  const nonFestival=candidates.filter(i=>!i.festival?.name);
  if(!c.isFestival&&nonFestival.length>=3)candidates=nonFestival;
  const references=[];
  for(const candidate of candidates.slice(0,12)) {
    if(references.length>=5)break;
    const full=extractSets(candidate).length?candidate:await get('https://api.setlist.fm/rest/1.0/setlist/'+encodeURIComponent(candidate.id));
    if(!full||full.id!==candidate.id||key(full.artist?.name)!==key(artist))continue;
    const date=referenceDate(full.eventDate);
    const matched=targetTour&&key(full.tour?.name)===targetTour;
    const ref={
      artist,sets:extractSets(full),matchType:matched?'tour-reference':'recent-reference',
      targetIdentity:targetIdentity(c,artist),
      sourceUrl:referenceURL(full.url),setlistFmId:full.id,
      tourEvidence:matched?{kind:'concert-tour',tour:full.tour.name}:null,
      sourceEvent:{artist:full.artist?.name||artist,date,venue:full.venue?.name||'',
        city:full.venue?.city?.name||'',country:full.venue?.city?.country?.code||'',
        tour:full.tour?.name||'',isFestival:!!full.festival?.name}
    };
    if(date&&date<c.date&&validWarmupReference(ref,artist,today))references.push(ref);
  }
  if(!references.length)return null;
  const best=references[0];
  return {...best,references,predictionVersion:2,
    songCount:best.sets.reduce((n,s)=>n+s.songs.length,0)};
}
