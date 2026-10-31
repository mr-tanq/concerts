import {discoverFestivals} from './festivalinfo.mjs';
import {normalizeArtistName,isTrackedName} from './podiuminfo.mjs';
import {searchLocation,matchesLocation} from '../../js/concert-countries.js';
import {sameSearchConcert,validateSearchRequest,isFestivalBrowse} from '../../js/concert-search-model.js';
import {searchConcerts} from './manual-concert-search.mjs';
import {searchByTaste,listeningCandidates} from './taste-concert-search.mjs';

export async function searchFestivalConcerts(request,{festivalCache={},identity={},startDate,endDate,deadline=Date.now()+420000,festivalDiscover=discoverFestivals,...options}={}) {
  const {artist,place}=validateSearchRequest(request),scope=searchLocation(place);
  const candidates=isFestivalBrowse(artist)?[]:artist?[{name:artist}]:listeningCandidates(identity);
  const tracked=candidates.map(c=>c.name);
  const {events,stats}=await festivalDiscover({trackedArtistNames:tracked,festivalQuery:artist,startDate,endDate,countries:null,cache:festivalCache,deadline,acceptEvent:e=>matchesLocation(e,scope),...options});
  const concerts=events.map(e=>{
    const matched=e.lineup.filter(n=>tracked.some(a=>isTrackedName(n,new Set([normalizeArtistName(a)]))));
    return {id:`rec-festivalinfo-${e.concertId}`,source:'festivalinfo',sourceId:e.concertId,artist:e.festivalName,festivalName:e.festivalName,isFestival:true,date:e.date,endDate:e.endDate,venue:e.venue,city:e.city,country:e.country,lineup:e.lineup,supportingArtists:[],matchedArtists:matched,time:null,image:e.image,ticketUrl:e.ticketUrl,sourceUrl:e.url,sourceApis:['festivalinfo'],match:{score:0,label:'Added by you',matchedBy:'manual',reason:matched.length?`Festival bill includes ${matched.join(', ')}`:isFestivalBrowse(artist)?'Festival found in your selected location':'Festival found by name',matchedArtists:matched}};
  });
  const incomplete=!!(stats.monthsMissing||stats.monthsStale||stats.editionsFailed);
  return {concerts,warnings:incomplete?['Some Festivalinfo months or editions could not be checked. Festival results may be incomplete.']:[],coverage:{sources:['Festivalinfo'],...stats,unavailable:stats.monthsMissing===stats.monthsTotal}};
}

// Both source families run independently under one deadline. A failed source
// must not discard verified results from the other one.
export async function searchIncludingFestivals(request,options={},adapters={}) {
  const deadline=options.deadline??Date.now()+420000;
  const normal=adapters.concerts || (String(request.artist||'').trim()?searchConcerts:searchByTaste);
  const festival=adapters.festivals || searchFestivalConcerts;
  if(isFestivalBrowse(request.artist)) {
    const found=await festival(request,{...options,deadline});
    return {...found,coverage:{...found.coverage,mode:'festivals',startDate:options.startDate,endDate:options.endDate}};
  }
  const [a,b]=await Promise.allSettled([normal(request,{...options,deadline}),festival(request,{...options,deadline})]);
  const warnings=[],concerts=[],coverage={};
  for(const [index,r]of [a,b].entries()) {
    if(r.status==='rejected'){warnings.push(`${index?'Festivalinfo':'Concert sources'} could not be checked. Results may be incomplete.`);continue;}
    warnings.push(...(r.value.warnings||[]));
    for(const c of r.value.concerts||[])if(!concerts.some(x=>sameSearchConcert(x,c)))concerts.push(c);
    coverage[index?'festivals':'concerts']=r.value.coverage||{};
  }
  if(a.status==='rejected'&&b.status==='rejected')throw new Error('No concert sources available');
  return {concerts:concerts.sort((a,b)=>a.date.localeCompare(b.date)),warnings:[...new Set(warnings)],coverage:{...(a.status==='fulfilled'?a.value.coverage:{}),startDate:options.startDate,endDate:options.endDate,...coverage,unavailable:!concerts.length&&[a,b].every(r=>r.status==='rejected'||r.value.coverage?.unavailable===true)}};
}
