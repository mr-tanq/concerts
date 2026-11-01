// Prefer verified timed lyrics. Plain lyrics are an explicitly unsynced
// fallback; timestamps are never invented from a song's length.
const cache=new Map(),pending=new Map();
const MAX_CACHE=100;
export const DURATION_TOLERANCE_SEC=2;
export const MAX_DURATION_DELTA_SEC=60;
const normalize=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
export function cleanTrackTitle(value) {
  return String(value||'').trim()
    .replace(/\s*[-–—]\s*(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|official\s+(?:audio|video|music video))\s*$/i,'')
    .replace(/\s*[([]\s*(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|official\s+(?:audio|video|music video))\s*[)\]]\s*$/i,'').trim();
}
export function cacheKey(artist,track,album,durationSec) {
  const dur=Number.isFinite(durationSec)&&durationSec>0?String(Math.round(durationSec)):'nodur';
  return `${normalize(artist)}::${normalize(track)}::${normalize(album)}::${dur}`;
}
export function parseLrc(value) {
  if(typeof value!=='string')return [];
  const lines=[],offset=Number(value.match(/\[offset:([+-]?\d+)\]/i)?.[1]||0);
  for(const raw of value.split(/\r?\n/)) {
    const stamps=[...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    if(!stamps.length||!raw.trimStart().startsWith(stamps[0][0]))continue;
    const text=raw.replace(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g,'').trim();
    if(!text)continue;
    for(const [,mm,ss,frac]of stamps)if(Number(ss)<60)lines.push({ms:Math.max(0,(Number(mm)*60+Number(ss))*1000+Number((frac||'0').padEnd(3,'0'))+offset),text});
  }
  return lines.sort((a,b)=>a.ms-b.ms);
}
function candidates(results,{artist,track,durationSec}) {
  if(!Array.isArray(results))return [];
  return results.filter(r=>r&&normalize(r.artistName)===normalize(artist)&&normalize(cleanTrackTitle(r.trackName))===normalize(cleanTrackTitle(track)))
    .map(r=>({r,delta:Number.isFinite(Number(r.duration))&&Number(r.duration)>0&&Number.isFinite(durationSec)&&durationSec>0?Math.abs(Number(r.duration)-durationSec):Infinity}))
    .filter(x=>!Number.isFinite(x.delta)||x.delta<=MAX_DURATION_DELTA_SEC)
    .sort((a,b)=>a.delta-b.delta).map(x=>x.r);
}
export function pickBestSyncedResult(results,signature) {
  return candidates(results,signature).find(r=>!r.instrumental&&parseLrc(r.syncedLyrics).length)||null;
}
const plain=value=>typeof value==='string'&&value.trim()&&value.length<=100000?value.trim():null;
async function fetchJson(url,timeout=6000) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const res=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});
    if(res.status===404)return null;
    if(!res.ok)throw Error(`HTTP ${res.status}`);
    return await res.json();
  }finally{clearTimeout(timer);}
}
const empty=status=>({lines:null,plainLyrics:null,source:null,status,instrumental:false});
// Lyrica adds extra providers without a local Worker.
export function pickLyricaResult(response,signature) {
  const data=response?.status==='success'?response.data:null;
  if(!data||data.hasTimestamps!==true||data.instrumental||
    normalize(data.artist)!==normalize(signature.artist)||
    normalize(cleanTrackTitle(data.title))!==normalize(cleanTrackTitle(signature.track)))return null;
  const duration=Number(data.duration);
  if(Number.isFinite(duration)&&duration>0&&Number.isFinite(signature.durationSec)&&signature.durationSec>0&&Math.abs(duration-signature.durationSec)>3)return null;
  const raw=data.timed_lyrics;
  if(!Array.isArray(raw)||raw.length<2||raw.length>5000)return null;
  const lines=[];let total=0,previous=-1;
  for(const line of raw) {
    if(!line||typeof line.text!=='string'||typeof line.start_time!=='number'||!Number.isFinite(line.start_time)||line.start_time<0||line.start_time<previous)return null;
    previous=line.start_time;
    const text=line.text.trim();if(!text)continue;
    total+=text.length;if(text.length>2000||total>100000)return null;
    if(Number.isFinite(signature.durationSec)&&signature.durationSec>0&&line.start_time>(signature.durationSec+10)*1000)return null;
    lines.push({ms:line.start_time,text});
  }
  if(lines.length<2||new Set(lines.map(line=>line.ms)).size<2)return null;
  return {lines,plainLyrics:null,source:'Lyrica',status:'synced',instrumental:false};
}
async function lookup({artist,track,album,durationSec}) {
  if(!normalize(artist)||!normalize(track))return empty('not-found');
  const signature={artist,track,durationSec},found=[];let failed=false;
  const attempt=async url=>{try{return await fetchJson(url);}catch{failed=true;return null;}};
  const fromSynced=r=>({lines:parseLrc(r.syncedLyrics),plainLyrics:null,source:'LRCLIB',status:'synced',instrumental:false});
  if(album&&Number.isFinite(durationSec)&&durationSec>0) {
    const params=new URLSearchParams({track_name:track,artist_name:artist,album_name:album,duration:String(Math.round(durationSec))});
    const hit=await attempt(`https://lrclib.net/api/get?${params}`);
    const verified=candidates([hit],signature)[0];
    if(verified){
      found.push(verified);
      if(verified.instrumental&&Math.abs(Number(verified.duration)-durationSec)<=DURATION_TOLERANCE_SEC)return {...empty('instrumental'),instrumental:true,source:'LRCLIB'};
      if(pickBestSyncedResult([verified],signature))return fromSynced(verified);
    }
  }
  // A failed exact lookup must not prevent the search endpoint or next source.
  for(const title of [...new Set([track,cleanTrackTitle(track)])]) {
    if(!title)continue;
    const results=await attempt('https://lrclib.net/api/search?'+new URLSearchParams({track_name:title,artist_name:artist}));
    found.push(...candidates(results,signature));
    const synced=pickBestSyncedResult(found,signature);
    if(synced)return fromSynced(synced);
  }
  const instrumental=candidates(found,signature).find(r=>r.instrumental&&Number.isFinite(durationSec)&&Math.abs(Number(r.duration)-durationSec)<=DURATION_TOLERANCE_SEC);
  if(instrumental)return {...empty('instrumental'),instrumental:true,source:'LRCLIB'};
  try {
    const params=new URLSearchParams({artist,song:cleanTrackTitle(track),timestamps:'true',pass:'true',sequence:'4,5,3,7',fast:'true'});
    const response=await fetchJson('https://test-0k.onrender.com/lyrics/?'+params,10000);
    const extra=pickLyricaResult(response,signature);
    if(extra)return extra;
    if(response?.status==='error'&&response.error?.message!=='No lyrics found')failed=true;
  }catch{failed=true;}
  const bestPlain=candidates(found,signature).find(r=>!r.instrumental&&plain(r.plainLyrics));
  if(bestPlain)return {...empty('plain'),plainLyrics:plain(bestPlain.plainLyrics),source:'LRCLIB'};
  // lyrics.ovh is an artist/title API returning plain text, not timed LRC.
  // Keep live/remix/acoustic labels in the request; clean only metadata noise.
  const response=await attempt(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(cleanTrackTitle(track))}`);
  const text=plain(response?.lyrics);
  return text?{...empty('plain'),plainLyrics:text,source:'lyrics.ovh'}:empty(failed?'unavailable':'not-found');
}
export async function getSyncedLyrics(signature,{force=false}={}) {
  const key=cacheKey(signature.artist,signature.track,signature.album,signature.durationSec),old=cache.get(key);
  if(!force&&old&&Date.now()<old.expires)return old.result;
  if(pending.has(key))return pending.get(key);
  const request=lookup(signature).then(result=>{
    const ttl=result.status==='unavailable'?30000:result.status==='not-found'?600000:1800000;
    cache.delete(key);cache.set(key,{result,expires:Date.now()+ttl});
    while(cache.size>MAX_CACHE)cache.delete(cache.keys().next().value);
    return result;
  }).finally(()=>pending.delete(key));
  pending.set(key,request);return request;
}
export function currentLine(lines,positionMs) {
  if(!Array.isArray(lines)||!Number.isFinite(positionMs)||positionMs<0)return null;
  let current=null;
  for(const line of lines){if(line.ms>positionMs)break;current=line;}
  return current?.text??null;
}
export function _clearCache(){cache.clear();pending.clear();}
export function _cacheSize(){return cache.size;}
