// A small, verified allowlist of festival editions, not a general web scraper.
// Dates/URLs were checked against the organisers on 2026-11-11. Every event
// requires fresh evidence from its official website before publication.
// Extend this list only after inspecting the next edition and its URL layout.
export const OFFICIAL_FESTIVAL_EDITIONS=Object.freeze([
  {
    id:'roadburn-2027',name:'Roadburn',date:'2027-04-15',endDate:'2027-04-18',
    venue:'Roadburn',city:'Tilburg',country:'NL',
    lineupUrl:'https://roadburn.com/line-up/',
    datesUrl:'https://roadburn.com/',
    artistPath:/^\/band\/[a-z0-9-]+\/?$/i,
    dateEvidence:/April\s+15\s*[-–]\s*18\s*,?\s*2027/i
  },
  {
    id:'graspop-2027',name:'Graspop Metal Meeting',
    date:'2027-06-17',endDate:'2027-06-20',
    venue:'Festivalpark Stenehei',city:'Dessel',country:'BE',
    lineupUrl:'https://www.graspop.be/nl/line-up/lijst',
    datesUrl:'https://www.graspop.be/nl/info/festival-essentials',
    artistPath:/^\/nl\/bands\/[a-z0-9-]+\/?$/i,
    dateEvidence:/Graspop Metal Meeting 2027.{0,160}17\s+tot en met\s+20\s+juni/i
  }
]);

import * as cheerio from 'cheerio';
import {normalizeArtistName,isTrackedName} from './podiuminfo.mjs';

const MAX_BYTES=4_000_000;
function allowedURL(url,edition) {
  try{
    const u=new URL(url),lineup=new URL(edition.lineupUrl),date=new URL(edition.datesUrl);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port
      &&u.origin===lineup.origin&&u.origin===date.origin
      &&[lineup.href,date.href].includes(u.href);
  }catch{return false;}
}
export async function fetchOfficialFestivalPage(url,edition){
  if(!allowedURL(url,edition))throw Error('Unapproved official festival URL');
  const r=await fetch(url,{signal:AbortSignal.timeout(15000),
    headers:{'User-Agent':'ListeningMirror/2.0 (personal festival discovery)','Accept':'text/html'}});
  if(!r.ok||!allowedURL(r.url,edition))throw Error('Official festival page unavailable');
  if(!/(?:^|;)text\/html(?:;|$)/i.test(r.headers.get('content-type')||''))throw Error('Not an HTML page');
  const parts=[];let bytes=0;
  for await(const part of r.body){bytes+=part.byteLength;if(bytes>MAX_BYTES)throw Error('Official page too large');parts.push(Buffer.from(part));}
  return Buffer.concat(parts).toString('utf8');
}
const cleanArtist=(value,edition)=>{
  let name=String(value||'').replace(/\s+/g,' ').trim();
  if(edition.id.startsWith('graspop-')) {
    name=name.replace(/^first time\s+/i,'').replace(/\s+(?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b.*$/i,'');
  } else if(edition.id.startsWith('roadburn-')) {
    name=name.replace(/\s+performing\s+.+$/i,'');
  }
  return name.trim();
};
export function parseOfficialFestival(lineupHtml,datesHtml,edition) {
  if(!OFFICIAL_FESTIVAL_EDITIONS.some(e=>e.id===edition?.id))return null;
  if(typeof lineupHtml!=='string'||typeof datesHtml!=='string')return null;
  const $dates=cheerio.load(datesHtml);
  const dateText=$dates('body').text().replace(/\s+/g,' ');
  if(!edition.dateEvidence.test(dateText))return null;
  const $=cheerio.load(lineupHtml),artists=new Map(),origin=new URL(edition.lineupUrl);
  $('a[href]').each((_,a)=>{
    const href=$(a).attr('href');let u;
    try{u=new URL(href,origin);}catch{return;}
    if(u.origin!==origin.origin||!edition.artistPath.test(u.pathname))return;
    const heading=$(a).find('h1,h2,h3,h4,.artist-name,.band-name').first().text();
    const raw=heading||$(a).text()||$(a).find('img[alt]').first().attr('alt')||'';
    const name=cleanArtist(raw,edition),k=normalizeArtistName(name);
    if(!k||name.length>120||name.length<2||/^(?:line-up|lineup|bands|artist)$/i.test(name))return;
    if(!artists.has(k))artists.set(k,name);
  });
  const lineup=[...artists.values()];
  // Guard against a redesigned site accidentally returning navigation links,
  // an old festival, or just a handful of unrelated band mentions.
  if(lineup.length<5||lineup.length>450)return null;
  return {
    source:'officialfestival',sourceApis:['officialfestival'],
    concertId:edition.id,festivalName:edition.name,isFestival:true,
    date:edition.date,endDate:edition.endDate,venue:edition.venue,
    city:edition.city,country:edition.country,
    lineup,matchedTracked:[],image:null,imageVersion:2,
    url:edition.lineupUrl,officialUrl:edition.lineupUrl,ticketUrl:null
  };
}
export async function discoverOfficialFestivals({
  trackedArtistNames,startDate,endDate,countries=['NL','BE'],
  editions=OFFICIAL_FESTIVAL_EDITIONS,cache={editions:{}},
  fetcher=fetchOfficialFestivalPage,now=Date.now(),pause=()=>new Promise(r=>setTimeout(r,1000))
}) {
  cache.editions ||= {};
  const tracked=new Set(trackedArtistNames.map(normalizeArtistName));
  const stats={sources:0,verified:0,reused:0,failed:0,published:0};
  const events=[];
  for(const edition of editions){
    if(edition.endDate<startDate||edition.date>endDate
      ||(countries&&!countries.includes(edition.country)))continue;
    stats.sources++;
    const old=cache.editions[edition.id],fresh=old?.version===1
      &&old?.event?.date===edition.date
      &&now-old.checkedAt>=0&&now-old.checkedAt<18*3600000;
    let event=null;
    if(fresh){event=old.event;stats.reused++;}
    else try{
      await pause();
      const dateHtml=await fetcher(edition.datesUrl,edition);
      await pause();
      const lineupHtml=await fetcher(edition.lineupUrl,edition);
      event=parseOfficialFestival(lineupHtml,dateHtml,edition);
      if(!event)throw Error('Official edition/lineup could not be verified');
      cache.editions[edition.id]={version:1,checkedAt:now,event};
      stats.verified++;
    }catch(e){
      stats.failed++;
      // A transient outage must not turn a known edition into a cancellation,
      // but old evidence must not be treated as a newly verified lineup.
      if(old?.version===1&&old.event?.date===edition.date
        &&now-old.checkedAt>=0&&now-old.checkedAt<7*86400000)event=old.event;
    }
    if(!event)continue;
    const matched=event.lineup.filter(n=>isTrackedName(n,tracked));
    if(matched.length){events.push({...event,matchedTracked:matched});stats.published++;}
  }
  return {events,stats};
}
