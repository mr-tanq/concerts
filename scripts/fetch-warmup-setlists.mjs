import {readFile,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {warmupArtistKey,pendingWarmupRequests} from '../js/warmup-setlist-model.js';
import {targetIdentity} from './lib/setlist-resolver.mjs';
import {resolveWarmupSetlist} from './lib/warmup-setlist-resolver.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const token=process.env.SETLISTFM_API_KEY;
const limit=Number(process.env.MAX_WARMUP_LOOKUPS||120);
if(!Number.isInteger(limit)||limit<1||limit>120)throw Error('Invalid warm-up lookup limit');
const read=async(file,fallback)=>{try{return JSON.parse(await readFile(path.join(root,file),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const planned=await read('data/planned.json',null);
if(!Array.isArray(planned?.concerts))throw Error('Invalid planned concerts');
const store=await read('data/warmup-setlists.json',{version:1,concerts:{}});
if(!store.concerts||typeof store.concerts!=='object'||Array.isArray(store.concerts))throw Error('Invalid warm-up snapshot');
const now=Date.now(),stamp=new Date(now).toISOString();
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const requestsData=await read('data/warmup-setlist-requests.json',{version:1,requests:{}});
if(requestsData.version!==1||!requestsData.requests||typeof requestsData.requests!=='object'||Array.isArray(requestsData.requests))throw Error('Invalid setlist request queue');
const queue=pendingWarmupRequests(planned,requestsData,store,now);
if(queue.length&&!token)throw Error('Missing SETLISTFM_API_KEY');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let lastCall=0;
const requests=new Map();
const get=url=>{
  if(!requests.has(url))requests.set(url,(async()=>{
    for(let attempt=0;attempt<3;attempt++) {
      await sleep(Math.max(0,700-(Date.now()-lastCall)));lastCall=Date.now();
      const res=await fetch(url,{headers:{'x-api-key':token,Accept:'application/json','User-Agent':'ListeningMirror/2.0'},signal:AbortSignal.timeout(15000)});
      if(res.status===404)return null;
      if((res.status===429||res.status>=500)&&attempt<2){await sleep(res.status===429?10000:1000);continue;}
      if(!res.ok)throw Error('Setlist API HTTP '+res.status);
      return res.json();
    }
  })());
  return requests.get(url);
};
let checked=0,errors=0;
for(const {c,artist,old,request}of queue.slice(0,limit)) {
  const entry=store.concerts[c.id] ||= {artists:{}};
  const identity=targetIdentity(c,artist),compatible=old?.targetIdentity===identity;
  checked++;
  try {
    const result=await resolveWarmupSetlist(c,artist,get,now);
    entry.artists[warmupArtistKey(artist)]={...(result||(compatible?old:null)||{artist,sets:[],matchType:'missing'}),targetIdentity:identity,requestId:request.requestId,lastAttemptAt:stamp,lastError:null};
  }catch(e){
    errors++;
    entry.artists[warmupArtistKey(artist)]={...(compatible?old:{artist,sets:[]}),targetIdentity:identity,requestId:request.requestId,lastAttemptAt:stamp,lastError:'Check unavailable'};
    console.warn('Warm-up setlist check unavailable for',artist);
    if(/HTTP (401|403|429)/.test(e.message)||errors>=3)break;
  }
}
store.meta={updatedAt:stamp,checked,errors,pending:Math.max(0,queue.length-checked)};
await writeFile(path.join(root,'data/warmup-setlists.json.tmp'),JSON.stringify(store,null,2)+'\n');
await rename(path.join(root,'data/warmup-setlists.json.tmp'),path.join(root,'data/warmup-setlists.json'));
console.log('Warm-up setlists:',checked,'checked,',store.meta.pending,'pending');
