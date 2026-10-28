import {getFile,putFile,isConflictError} from './github-api.js';
import {warmupArtistKey,warmupIdentity,warmupRequestKey} from './warmup-setlist-model.js?v=warmup-demand-20261029';
const QUEUE='data/warmup-setlist-requests.json',RESULTS='data/warmup-setlists.json';
export async function requestWarmupSetlist(config,c,artist,options={}) {
  const read=options.read||getFile,write=options.write||putFile;
  const now=options.now??Date.now(),identity=warmupIdentity(c,artist);
  const load=async(path,empty)=>{try{return await read(config,path);}catch(e){if(e.status===404)return {json:empty};throw e;}};
  for(let attempt=0;attempt<3;attempt++) {
    const [queue,result]=await Promise.all([load(QUEUE,{version:1,requests:{}}),load(RESULTS,{version:1,concerts:{}})]);
    if(queue.json.version!==1||!queue.json.requests||typeof queue.json.requests!=='object'||Array.isArray(queue.json.requests))throw Error('Invalid setlist request queue.');
    const old=result.json.concerts?.[c.id]?.artists?.[warmupArtistKey(artist)];
    const pending=queue.json.requests[warmupRequestKey(c,artist)];
    const age=now-Date.parse(pending?.requestedAt);
    if(pending?.identity===identity&&pending.requestId!==old?.requestId&&age>=0&&age<20*60000)return {request:pending};
    const checked=old?.targetIdentity===identity&&Number.isFinite(Date.parse(old.lastAttemptAt));
    if(checked&&!options.force)return {data:result.json};
    if(checked&&now-Date.parse(old.lastAttemptAt)<5*60000)throw Error('Please wait five minutes before refreshing this setlist.');
    const request={concertId:c.id,artist,identity,requestedAt:new Date(now).toISOString(),requestId:options.requestId||crypto.randomUUID()};
    queue.json.requests[warmupRequestKey(c,artist)]=request;
    try {await write(config,QUEUE,queue.json,queue.sha,'Request warm-up setlist');return {request};}
    catch(e){if(!isConflictError(e)||attempt===2)throw e;}
  }
}
