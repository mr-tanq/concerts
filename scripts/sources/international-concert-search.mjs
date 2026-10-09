import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { countryCode, matchesLocation } from '../../js/concert-countries.js';
import { searchKey, sameSearchConcert } from '../../js/concert-search-model.js';
import { validDate } from '../../js/concert-schedule.js';

export function sourceURL(value, domain, base=`https://www.${domain}/`) {
  if (typeof value!=='string' || !value.trim()) return null;
  try { const u=new URL(value,base);if(u.protocol!=='https:' || u.username || u.password || ![domain,`www.${domain}`].includes(u.hostname))return null;u.search='';u.hash='';return u.href; } catch { return null; }
}
const skId = url => {try{return new URL(url).pathname.match(/^\/concerts\/(\d+)-/)?.[1] || new URL(url).pathname.match(/^\/festivals\/[^/]+\/id\/(\d+)-/)?.[1] || null;}catch{return null;}};
const safeLink = value => {try{const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password ? u.href : null;}catch{return null;}};
const sameArtist = (a,b) => !!searchKey(a) && searchKey(a)===searchKey(b);
function eventObjects($, selector='script[type="application/ld+json"]') {
  const events=[];
  const visit=value=>{if(Array.isArray(value))return value.forEach(visit);if(!value || typeof value!=='object')return;
    if([value['@type']].flat().some(t=>['Event','MusicEvent'].includes(t)))events.push(value);
    for(const k of ['@graph','itemListElement','item','subEvent'])if(value[k])visit(value[k]);
  };
  $(selector).each((_,n)=>{try{visit(JSON.parse($(n).text()));}catch{}});return events;
}
export function songkickArtists(html, artist) {
  const $=cheerio.load(html), urls=new Set();
  $('a.search-link[data-resource-name="artist"]').each((_,n)=>{
    const url=sourceURL($(n).attr('href'),'songkick.com');
    if(url && /^\/artists\/\d+-[^/]+$/.test(new URL(url).pathname) && sameArtist($(n).text(),artist))urls.add(url);
  });return [...urls];
}
export function songkickEvents(html, artist, {upcoming=false,expectedId=null}={}) {
  const $=cheerio.load(html), concerts=[];
  for(const e of eventObjects($,upcoming ? '.upcoming script[type="application/ld+json"]' : undefined)) {
    if(/EventCancelled|EventPostponed|OnlineEventAttendanceMode/.test(`${e.eventStatus} ${e.eventAttendanceMode}`))continue;
    const sourceUrl=sourceURL(e.url,'songkick.com'),sourceId=skId(sourceUrl);
    if(!sourceId || (expectedId && sourceId!==expectedId))continue;
    const performers=[e.performer].flat().filter(Boolean).map(p=>typeof p==='string'?p:p.name).filter(n=>typeof n==='string' && n.trim());
    const display=performers.find(n=>sameArtist(n,artist));if(!display)continue;
    const locations=[e.location].flat().filter(Boolean);if(locations.length!==1)continue;
    const location=locations[0],country=countryCode(location.address?.addressCountry),date=String(e.startDate || '').slice(0,10);
    // Songkick dates are venue-local. UTC-only values need additional zone evidence.
    if(!country || typeof location.name!=='string' || !location.name.trim() || typeof location.address?.addressLocality!=='string' || !location.address.addressLocality.trim() || !validDate(date) || /Z$/i.test(e.startDate || ''))continue;
    const isFestival=sourceUrl.includes('/festivals/');
    if(isFestival && String(e.endDate || '').slice(0,10)!==date)continue;
    const image=typeof e.image==='string'?e.image:e.image?.url;
    concerts.push({artist:display,eventName:e.name,lineup:performers,supportingArtists:[],date,venue:location.name,city:location.address.addressLocality,country,image:safeLink(image),ticketUrl:sourceUrl,sourceUrl,source:'songkick',sourceId,isFestival});
  }
  return concerts;
}
// More.com's Greek catalogue also lists Cyprus. The country is accepted only
// with explicit country metadata or a known Greek region on this Greek page.
const greekRegions=new Set('Attiki|Αττική|Thessaloniki|Θεσσαλονίκη|Αχαΐα|Achaia|Messinia|Μεσσηνία|Ηράκλειο|Heraklion|Ιωάννινα|Ioannina|Κέρκυρα|Corfu|Κοζάνη|Kozani|Λάρισα|Larisa|Larissa|Μαγνησία|Magnisia|Ξάνθη|Xanthi|Ρέθυμνο|Rethimno|Ροδόπη|Rodopi|Σέρρες|Serres|Τρίκαλα|Trikala|Φθιώτιδα|Fthiotida|Χανιά|Chania|Χίος|Chios'.split('|').map(searchKey));
function moreBill(title, artist) {
  if(/tribute|αφι[εέ]ρωμα/i.test(title))return null;
  const parts=title.split(/\s+(?:with special guests?:|with guests?:|special guests?:|support:|\+)\s*/i);
  const names=parts.map(n=>n.replace(/\s*\|\s*.+$|\s+live(?:\s|$).*$/i,'').trim());
  return names.find(n=>sameArtist(n,artist)) || null;
}
export function moreEvents(html, artist) {
  const $=cheerio.load(html), concerts=[];
  $('article.play-template[itemtype$="/Event"]').each((_,n)=>{
    const row=$(n),title=row.find('h3[itemprop="name"]').first().text().trim(),display=moreBill(title,artist);
    if(!display || /cancelled|postponed|ακυρ[ωώ]|αναβ[οά]λ/i.test(title))return;
    const sourceUrl=sourceURL(row.find('a.play-template__main').attr('href'),'more.com');
    if(!sourceUrl || !new URL(sourceUrl).pathname.startsWith('/gr-en/tickets/music/'))return;
    const date=String(row.find('meta[itemprop="startDate"]').attr('content') || '').slice(0,10),end=String(row.find('meta[itemprop="endDate"]').attr('content') || '').slice(0,10);
    if(!validDate(date) || (end && end!==date))return;
    const loc=row.find('[itemprop="location"]').first(),venue=loc.find('[itemprop="name"]').first().text().trim(),city=loc.find('[itemprop="addressLocality"]').attr('content')?.trim();
    const rawCountry=loc.find('[itemprop="addressCountry"]').attr('content'),region=loc.find('[itemprop="addressRegion"]').attr('content');
    const country=countryCode(rawCountry) || (!rawCountry && greekRegions.has(searchKey(region)) ? 'GR' : null);
    if(country!=='GR' || !venue || !city || /multiple|πολλαπλ/i.test(venue))return;
    const image=sourceURL(row.find('meta[itemprop="image"]').attr('content'),'more.com');
    const sourceId=createHash('sha256').update(`${sourceUrl}|${date}|${searchKey(venue)}|${searchKey(city)}`).digest('hex').slice(0,16);
    concerts.push({artist:display,eventName:title,lineup:[display],supportingArtists:[],date,venue,city,country,image,ticketUrl:sourceUrl,sourceUrl,source:'more',sourceId,isFestival:false});
  });return concerts;
}
export async function searchInternationalConcerts({artist,scope,startDate,endDate,fetcher,deadline}) {
  const warnings=[],found=[],checked=[];let catalogueOK=false,failed=0;
  const inRange=c=>c.date>=startDate && c.date<=endDate && matchesLocation(c,scope);
  const enoughTime=()=>Date.now()<deadline-32000;
  try {
    const search=await fetcher(`https://www.songkick.com/search?type=artists&query=${encodeURIComponent(artist)}`,'songkick.com');
    if (!/Artists Search Results/i.test(cheerio.load(search)('title').text())) throw new Error('Unrecognised search page');
    const artists=songkickArtists(search,artist);
    if (!artists.length) catalogueOK=true;if(artists.length>3)warnings.push('Several artists share this name. Some matches could not be checked.');
    const candidates=new Map();
    for(const url of artists.slice(0,3)) {
      if(!enoughTime()){failed++;break;}
      try{const html=await fetcher(`${url}/calendar`,'songkick.com');if(!cheerio.load(html)('.upcoming').length)throw new Error('Unrecognised calendar');catalogueOK=true;for(const c of songkickEvents(html,artist,{upcoming:true}).filter(inRange))candidates.set(c.sourceId,c);}catch{failed++;}
    }
    if(candidates.size>20)warnings.push('Only the first 20 matching Songkick events were checked. Results may be incomplete.');
    for(const c of [...candidates.values()].slice(0,20)) {
      if(!enoughTime()){failed++;break;}
      try{const html=await fetcher(c.sourceUrl,'songkick.com');const event=songkickEvents(html,artist,{expectedId:c.sourceId}).find(inRange);if(event)found.push(event);}catch{failed++;}
    }
    checked.push('Songkick');
  } catch {warnings.push('Songkick could not be checked. These results may be incomplete.');}
  if(failed)warnings.push('Some Songkick artist or event pages could not be checked. These results may be incomplete.');
  if(scope.country==='GR') {
    try{
      if(!enoughTime())throw new Error('Time limit');
      const html=await fetcher('https://www.more.com/gr-en/tickets/music/','more.com');
      if (!cheerio.load(html)('article.play-template[itemtype$="/Event"]').length) throw new Error('Unrecognised catalogue');
      found.push(...moreEvents(html,artist).filter(inRange));checked.push('More.com');catalogueOK=true;
    }catch{warnings.push('More.com could not be checked. These results may be incomplete.');}
  }
  const concerts=[];
  for(const c of found) {
    const prior=concerts.find(other=>sameSearchConcert(other,c));
    if(prior){if(c.source==='more')prior.ticketUrl=c.ticketUrl;prior.sourceApis=[...new Set([...prior.sourceApis,c.source])];continue;}
    concerts.push({...c,id:`rec-${c.source}-${c.sourceId}`,time:null,sourceApis:[c.source],match:{score:0,label:'Added by you',matchedBy:'manual',reason:'Found by your search',matchedArtists:[c.artist]}});
  }
  return {concerts:concerts.sort((a,b)=>a.date.localeCompare(b.date)),warnings,coverage:{startDate,endDate,country:scope.country,sources:checked,unavailable:!catalogueOK}};
}
