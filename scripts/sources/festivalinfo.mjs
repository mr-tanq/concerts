// Festival editions have their own identity and confirmed bill; a festival
// title is never treated as a band and prose mentions never become a lineup.
import * as cheerio from 'cheerio';
import {normalizeArtistName, isTrackedName} from './podiuminfo.mjs';
import {validDate} from '../../js/concert-schedule.js';
import {searchKey,isFestivalBrowse} from '../../js/concert-search-model.js';
import {countryCode} from '../../js/concert-countries.js';
const VERSION = 1;
const DAY = 86400000;
export function festivalURL(raw, base='https://www.festivalinfo.nl/') {
  try {
    const u=new URL(raw,base);
    return u.protocol==='https:' && !u.username && !u.password && !u.port && ['festivalinfo.nl','www.festivalinfo.nl'].includes(u.hostname) && /^\/festival\/\d+\/[^/]+\/\d{4}\/$/.test(u.pathname) ? `https://www.festivalinfo.nl${u.pathname}` : null;
  } catch {return null;}
}
const httpsURL=raw=>{try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
export function parseFestivalEvents(html, expectedURL=null, {includeCancelled=false}={}) {
  const $=cheerio.load(html), output=new Map(), expected=expectedURL && festivalURL(expectedURL);
  if(expectedURL && !expected)return [];
  function visit(e) {
    if(Array.isArray(e))return e.forEach(visit);
    if(!e || typeof e!=='object')return;
    if([e['@type']].flat().includes('Festival')) {
      const url=festivalURL(e.url || e['@id']);
      const date=String(e.startDate || '').slice(0,10), endDate=String(e.endDate || e.startDate || '').slice(0,10);
      const loc=[e.location].flat().filter(Boolean), name=String(e.name || '').trim();
      const country=loc.length===1 ? countryCode(loc[0].address?.addressCountry) : null;
      const city=loc.length===1 && String(loc[0].address?.addressLocality || '').trim();
      const cancelled=/EventCancelled|EventPostponed|OnlineEventAttendanceMode/.test(`${e.eventStatus} ${e.eventAttendanceMode}`);
      if(url && (!expected || url===expected) && name && validDate(date) && validDate(endDate) && endDate>=date && Date.parse(endDate)-Date.parse(date)<=31*DAY && url.endsWith(`/${date.slice(0,4)}/`) && country && city && (includeCancelled || !cancelled)) {
        const lineup=[...new Map([e.performer].flat().filter(Boolean).map(p=>typeof p==='string'?p:p.name).filter(n=>typeof n==='string'&&n.trim()).map(n=>[normalizeArtistName(n),n.trim()])).values()];
        // Only the confirmed-artists section on the edition's own page can
        // supplement its structured bill, never sidebar artist/news links.
        if(expected) $('#grootte .confirmed_artist p, #alfabet .confirmed_artist p').each((_,n)=>{
          const artist=$(n).text().trim();if(artist&&!lineup.some(a=>normalizeArtistName(a)===normalizeArtistName(artist)))lineup.push(artist);
        });
        const image=(typeof e.image==='string'?e.image:e.image?.url) || (expected ? $('meta[property="og:image"]').attr('content') : null);
        output.set(url,{source:'festivalinfo',cancelled,concertId:url.split('/')[4],festivalName:name,isFestival:true,lineup,date,endDate,venue:String(loc[0].name || name).trim(),city,country,url,image:httpsURL(image),ticketUrl:httpsURL([e.offers].flat().find(o=>o?.url)?.url)});
      }
    }
    for(const key of ['@graph','itemListElement','item'])if(e[key])visit(e[key]);
  }
  $('script[type="application/ld+json"]').each((_,n)=>{try{visit(JSON.parse($(n).text()));}catch{}});
  return [...output.values()];
}
export function festivalMonthKeys(startDate,endDate) {
  const out=[],cursor=new Date(startDate.slice(0,7)+'-01T12:00Z');
  while(cursor.toISOString().slice(0,7)<=endDate.slice(0,7)) {out.push(cursor.toISOString().slice(0,7));cursor.setUTCMonth(cursor.getUTCMonth()+1);}
  return out;
}
export async function fetchFestivalPage(url) {
  let last;
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const r=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'ListeningMirror/1.0 (personal festival discovery)'}});
      const final=new URL(r.url);
      if(!r.ok || final.protocol!=='https:' || !['festivalinfo.nl','www.festivalinfo.nl'].includes(final.hostname))throw new Error(`Festivalinfo HTTP ${r.status}`);
      if(Number(r.headers.get('content-length'))>8000000)throw new Error('Festival page too large');
      let size=0;const chunks=[];
      for await(const chunk of r.body){size+=chunk.byteLength;if(size>8000000)throw new Error('Festival page too large');chunks.push(Buffer.from(chunk));}
      return Buffer.concat(chunks).toString('utf8');
    }catch(error){last=error;if(attempt<2)await new Promise(r=>setTimeout(r,1000*2**attempt));}
  }
  throw last;
}
export async function discoverFestivals({trackedArtistNames,festivalQuery='',acceptEvent=()=>true,deadline=Infinity,clock=Date.now,startDate,endDate,countries=['NL','BE'],cache={months:{},editions:{}},fetcher=fetchFestivalPage,now=Date.now(),pause=()=>new Promise(r=>setTimeout(r,1000))}) {
  cache.months ||= {};cache.editions ||= {};
  const tracked=new Set(trackedArtistNames.map(normalizeArtistName)), candidates=new Map();
  const stats={monthsTotal:0,monthsMissing:0,monthsStale:0,editionsFailed:0,editionsStale:0};
  const wanted=e=>!e.cancelled&&(e.endDate||e.date)>=startDate&&e.date<=endDate&&(!countries || countries.includes(e.country))&&acceptEvent(e);
  const festivalKey=(name,year)=>searchKey(name).replace(new RegExp('(?:^| )'+year+'$'),'').replace(/\bfestival\b/g,'').trim();
  const matches=e=>isFestivalBrowse(festivalQuery) || e.lineup.some(n=>isTrackedName(n,tracked)) || (!!festivalQuery && !!festivalKey(festivalQuery,e.date.slice(0,4)) && festivalKey(festivalQuery,e.date.slice(0,4))===festivalKey(e.festivalName,e.date.slice(0,4)));
  for(const month of festivalMonthKeys(startDate,endDate)) {
    stats.monthsTotal++;
    const old=cache.months[month];let events;
    if(old?.version===VERSION && now-old.checkedAt<20*3600000)events=old.events;
    else try {
      if(clock()>deadline-70000)throw new Error('Festival search time limit');
      await pause();
      const html=await fetcher(`https://www.festivalinfo.nl/festivals/?type_select=maand&maand=${month.slice(5)}&jaar=${month.slice(0,4)}`);
      // A challenge page or ignored month parameter must not wipe the cache.
      const $=cheerio.load(html);
      const monthLinks=$('a[href]').map((_,n)=>$(n).attr('href')).get();
      const validMonth=monthLinks.some(h=>{try{const u=new URL(h,'https://www.festivalinfo.nl');return u.searchParams.get('type_select')==='maand'&&u.searchParams.has('maand')&&u.searchParams.has('jaar');}catch{return false;}});
      if(!validMonth)throw new Error('Unrecognised festival month page');
      events=parseFestivalEvents(html).filter(e=>e.date.slice(0,7)<=month && e.endDate.slice(0,7)>=month);
      // Festivalinfo links to the adjacent months, which verifies the requested
      // month even when no festivals have been announced for it yet.
      const adjacent=new Date(month+'-01T12:00Z');adjacent.setUTCMonth(adjacent.getUTCMonth()+1);
      const nextMonth=adjacent.toISOString().slice(0,7);
      if(!monthLinks.some(h=>{try{const u=new URL(h,'https://www.festivalinfo.nl');return u.searchParams.get('jaar')+'-'+u.searchParams.get('maand')===nextMonth;}catch{return false;}}))throw new Error('Wrong festival month returned');
      cache.months[month]={version:VERSION,checkedAt:now,events};
    }catch{if(old?.version===VERSION){events=old.events;stats.monthsStale++;}else{events=[];stats.monthsMissing++;}}
    for(const e of events)if(wanted(e)&&matches(e))candidates.set(e.url,e);
  }
  // Recheck previously matched editions as well: an edition can disappear
  // from the catalogue because of cancellation or a changed bill.
  for(const old of Object.values(cache.editions))if(old.version===VERSION && wanted(old.event) && matches(old.event) && !candidates.has(old.event.url))candidates.set(old.event.url,old.event);
  const events=[];
  for(const candidate of candidates.values()) {
    const old=cache.editions[candidate.url];let event;
    if(old?.version===VERSION&&now-old.checkedAt<20*3600000)event=old.event;
    else try {
      if(clock()>deadline-70000)throw new Error('Festival search time limit');
      await pause();
      event=parseFestivalEvents(await fetcher(candidate.url),candidate.url,{includeCancelled:true})[0];
      if(!event)throw new Error('Unrecognised festival edition');
      cache.editions[candidate.url]={version:VERSION,checkedAt:now,event};
    }catch{stats.editionsFailed++;if(old?.version===VERSION){event=old.event;stats.editionsStale++;}}
    if(event && wanted(event) && matches(event))events.push({...event,matchedTracked:event.lineup.filter(n=>isTrackedName(n,tracked))});
  }
  for(const [key,entry]of Object.entries(cache.months))if(key<startDate.slice(0,7)||key>endDate.slice(0,7))delete cache.months[key];
  for(const [key,entry]of Object.entries(cache.editions))if((entry.event.endDate||entry.event.date)<startDate||entry.event.date>endDate)delete cache.editions[key];
  return {events,stats};
}
