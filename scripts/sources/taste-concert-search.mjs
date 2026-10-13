import { searchConcerts, fetchHTML } from './manual-concert-search.mjs';
import { searchKey, sameSearchConcert } from '../../js/concert-search-model.js';
import { searchLocation, matchesLocation } from '../../js/concert-countries.js';

export function listeningCandidates(identity) {
  const pool=new Map();
  for(const [rows,recent] of [[identity.topArtistsOverall || [],false],[identity.topArtistsMonth || [],true]]) {
    for(const a of rows) {
      if(typeof a.name!=='string' || !searchKey(a.name) || !(Number(a.playcount)>0))continue;
      const key=searchKey(a.name),prev=pool.get(key) || {name:a.name,overall:0,recent:0};
      prev[recent?'recent':'overall']=Number(a.playcount);pool.set(key,prev);
    }
  }
  return [...pool.values()].map(a=>({...a,score:60+Math.min(20,Math.log2(1+a.overall)*1.5)+Math.min(20,Math.log2(1+a.recent)*3),reason:a.recent?`${a.recent} plays in your past-month Last.fm snapshot`:`${a.overall} plays in your all-time Last.fm snapshot`,kind:'listened'})).sort((a,b)=>b.score-a.score);
}
export async function searchByTaste(request,{identity,dayCacheEntries,startDate,endDate,apiKey=process.env.LASTFM_API_KEY,fetcher=fetch,search=searchConcerts,now=Date.now}={}) {
  const seeds=listeningCandidates(identity || {});
  if(!seeds.length)throw new Error('No listening snapshot available');
  const deadline=now()+390000, warnings=[],related=new Map();
  if(apiKey) {
    for(const seed of seeds.slice(0,4)) {
      try {
        const url=new URL('https://ws.audioscrobbler.com/2.0/');
        url.search=new URLSearchParams({method:'artist.getsimilar',artist:seed.name,api_key:apiKey,format:'json',limit:'6',autocorrect:'1'});
        const response=await fetcher(url,{signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error('Unavailable');
        const json=await response.json();if(json.error)throw new Error('Unavailable');
        for(const a of json.similarartists?.artist || []) {
          const key=searchKey(a.name),similarity=Number(a.match);
          if(typeof a.name!=='string' || a.name.length>100 || key.length<2 || !Number.isFinite(similarity) || similarity<0.3 || similarity>1 || seeds.some(s=>searchKey(s.name)===key))continue;
          const candidate={name:a.name,score:30+similarity*20,kind:'similar',reason:`Similar to ${seed.name} on Last.fm`};
          if(!related.has(key) || related.get(key).score<candidate.score)related.set(key,candidate);
        }
      } catch {warnings.push('Some similar-artist suggestions could not be loaded.');}
    }
  } else warnings.push('Similar-artist suggestions are unavailable; searching your listening favourites only.');
  const known=seeds.slice(0,16),similar=[...related.values()].sort((a,b)=>b.score-a.score).slice(0,8);
  const candidates=[];
  for(let i=0;i<known.length;i++){candidates.push(known[i]);if(i%2===1 && similar.length)candidates.push(similar.shift());}
  candidates.push(...similar);
  const cache=new Map();
  const page=(url,domain)=>{
    const key=domain+'|'+url;
    if(!cache.has(key))cache.set(key,fetchHTML(url,domain));
    return cache.get(key);
  };
  const concerts=[],scope=searchLocation(request.place);let checked=0,failed=0;
  for(const candidate of candidates) {
    if(now()>deadline-35000)break;
    try {
      const found=await search({...request,artist:candidate.name},{dayCacheEntries,startDate,endDate,deadline:Math.min(deadline,now()+65000),officialFetcher:page,internationalFetcher:page,podiumFetcher:async url=>{await new Promise(r=>setTimeout(r,1200));return page(url,'podiuminfo.nl');}});
      checked++;warnings.push(...(found.warnings || []));
      for(const c of found.concerts || []) {
        if(c.date<startDate || c.date>endDate || !matchesLocation(c,scope))continue;
        const match={score:Math.round(candidate.score),label:candidate.kind==='similar'?'Discovery':'In your listening',matchedBy:candidate.kind==='similar'?'similar':'listening',reason:candidate.reason,matchedArtists:[candidate.name]};
        const old=concerts.find(x=>sameSearchConcert(x,c));
        if(old){if(match.score>old.match.score)old.match=match;continue;}
        concerts.push({...c,match});
      }
    } catch {failed++;}
  }
  warnings.push(`Focused search: ${checked} of ${candidates.length} selected artists checked. This is not a complete venue or country listing.`);
  if(failed)warnings.push('Some artist searches failed. Results may be incomplete.');
  return {concerts:concerts.sort((a,b)=>b.match.score-a.match.score || a.date.localeCompare(b.date)),warnings:[...new Set(warnings)],coverage:{mode:'taste',artistsChecked:checked,artistsSelected:candidates.length,unavailable:checked===0,profileUpdatedAt:identity.meta?.lastUpdated || null}};
}
