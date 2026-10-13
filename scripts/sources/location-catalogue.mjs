import * as cheerio from 'cheerio';
import {createHash} from 'node:crypto';
import {SEARCH_VENUES,fetchHTML,officialURL,parseOfficialEvents,placeMatches} from './manual-concert-search.mjs';
import {normalizeArtistName,splitLineup,isTrackedName,detectCountry,parseConcertPageTitle} from './podiuminfo.mjs';
import {moreEvents} from './international-concert-search.mjs';
import {searchKey,sameSearchConcert} from '../../js/concert-search-model.js';
import {searchLocation,matchesLocation} from '../../js/concert-countries.js';

export async function searchLocationCatalogue(request,{candidates,dayCacheEntries={},startDate,endDate,deadline,fetcher=fetchHTML,now=Date.now}={}) {
  const scope=searchLocation(request.place),warnings=[],concerts=[],checkedSources=[];
  const tracked=new Set(candidates.map(a=>normalizeArtistName(a.name)));
  const matchNames=names=>candidates.filter(a=>names.some(n=>isTrackedName(n,new Set([normalizeArtistName(a.name)]))));
  const enough=()=>now()<deadline-32000;
  const inPlace=c=>scope.country?matchesLocation(c,scope):(matchesLocation(c,scope) || placeMatches(c,request.place));
  function add(c) {
    if(c.date<startDate || c.date>endDate || !inPlace(c))return;
    const matched=matchNames(c.lineup || [c.artist]);
    if(!matched.length)return;
    matched.sort((a,b)=>b.score-a.score);
    const best=matched[0],match={score:Math.round(best.score),label:best.kind==='similar'?'Discovery':'In your listening',matchedBy:best.kind==='similar'?'similar':'listening',reason:best.reason,matchedArtists:matched.map(a=>a.name)};
    const old=concerts.find(x=>sameSearchConcert(x,c));
    if(old){if(c.source==='official')old.officialUrl=c.sourceUrl;if(match.score>old.match.score)old.match=match;return;}
    const id=c.source==='podiuminfo'?`rec-podiuminfo-${c.sourceId}`:`rec-${c.source}-${createHash('sha256').update(c.sourceUrl+'|'+c.date+'|'+searchKey(c.venue)).digest('hex').slice(0,16)}`;
    concerts.push({...c,id,time:null,isFestival:c.isFestival===true,sourceApis:[c.source],match});
  }
  const venues=SEARCH_VENUES.filter(v=>inPlace({venue:v[0],city:v[1],country:v[2]}));
  let pagesFailed=0,limited=false;
  for(const venue of venues) {
    if(!enough()){limited=true;break;}
    const url=`https://${venue[3]}${venue[4]}`;
    try {
      const html=await fetcher(url,venue[3]),$=cheerio.load(html),links=new Map();
      const namesIn=text=>{
        const t=' '+searchKey(text)+' ';
        return candidates.filter(a=>t.includes(' '+searchKey(a.name)+' '));
      };
      const agendaMatches=namesIn($.text());
      for(const a of agendaMatches)for(const c of parseOfficialEvents(html,url,venue,a.name))add({...c,source:'official'});
      $('a[href]').each((_,n)=>{
        const link=officialURL($(n).attr('href'),venue[3],url);
        const matches=namesIn([$(n).text(),$(n).attr('title'),$(n).find('img').attr('alt')].filter(Boolean).join(' '));
        if(link && link!==url && matches.length)links.set(link,matches);
      });
      for(const [link,matches] of links) {
        if(!enough()){limited=true;break;}
        try {
          const event=await fetcher(link,venue[3]);
          for(const a of matches)for(const c of parseOfficialEvents(event,link,venue,a.name))add({...c,source:'official'});
        }catch{pagesFailed++;}
      }
      checkedSources.push(venue[0]);
    }catch{pagesFailed++;}
  }
  let catalogueDays=0,candidatesFound=0,eventsChecked=0;
  if(!scope.country || ['NL','BE'].includes(scope.country)) {
    const events=new Map();
    for(const [date,entry] of Object.entries(dayCacheEntries)) {
      if(date<startDate || date>endDate || !Array.isArray(entry.candidates))continue;
      catalogueDays++;
      for(const c of entry.candidates) {
        if(splitLineup(c.rawTitle,tracked).some(n=>isTrackedName(n,tracked)))events.set(String(c.concertId),c.href);
      }
    }
    candidatesFound=events.size;
    const hint=searchKey(scope.place),ordered=[...events].sort((a,b)=>Number(searchKey(b[1]).includes(hint))-Number(searchKey(a[1]).includes(hint)));
    for(const [sourceId,href] of ordered) {
      if(!enough()){limited=true;break;}
      try {
        const url=new URL(href,'https://www.podiuminfo.nl');
        if(!officialURL(url.href,'podiuminfo.nl') || !/^\/concert\/\d+\//.test(url.pathname))continue;
        await new Promise(r=>setTimeout(r,1200));
        const html=await fetcher(url.href,'podiuminfo.nl'),$=cheerio.load(html),c=parseConcertPageTitle(html,tracked);
        eventsChecked++;
        if(!c || /afgelast|geannuleerd|cancelled|canceled|verplaatst/i.test($('h1').first().text()))continue;
        add({...c,artist:c.lineup[0],supportingArtists:c.lineup.slice(1),source:'podiuminfo',sourceId,sourceUrl:url.href,country:detectCountry(c.city)});
      }catch{pagesFailed++;}
    }
    if(catalogueDays)checkedSources.push('Podiuminfo');
    warnings.push(`Podiuminfo index: ${catalogueDays} days available in the requested date range. Missing days are not treated as empty.`);
  }
  if(scope.country==='GR' || !scope.country && !venues.length) {
    if(enough())try {
      const html=await fetcher('https://www.more.com/gr-en/tickets/music/','more.com'),$=cheerio.load(html);
      const titles=$('article.play-template[itemtype$="/Event"] h3[itemprop="name"]').map((_,n)=>$(n).text()).get();
      if(!titles.length)throw new Error('Unrecognised catalogue');
      const text=' '+searchKey(titles.join(' '))+' ';
      for(const a of candidates.filter(a=>text.includes(' '+searchKey(a.name)+' ')))for(const c of moreEvents(html,a.name))add(c);
      checkedSources.push('More.com');
      warnings.push('More.com covers the events present on its music catalogue page; it is not a complete listing of Greece.');
    }catch{pagesFailed++;}else limited=true;
  }
  if(pagesFailed)warnings.push(`${pagesFailed} programme or event pages could not be verified.`);
  if(limited)warnings.push('The search reached its time limit. Some event pages remain unchecked.');
  return {concerts:concerts.sort((a,b)=>b.match.score-a.match.score || a.date.localeCompare(b.date)),warnings,coverage:{mode:'taste',strategy:'location-catalogue',artistsCompared:candidates.length,sources:checkedSources,catalogueDays,candidatesFound,eventsChecked,limited,unavailable:checkedSources.length===0}};
}
