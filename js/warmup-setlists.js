import {selectWarmupReference,sameTourReference,referenceURL,warmupArtistKey,warmupIdentity} from './warmup-setlist-model.js?v=warmup-demand-20261029';
import {requestWarmupSetlist} from './warmup-setlist-request.js?v=warmup-demand-20261029';
import {getGithubConfig,getFile} from './github-api.js';
let snapshot;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function loadSnapshot() {
  snapshot ||= (async()=>{
    for(const url of ['https://raw.githubusercontent.com/mr-tanq/concerts/main/data/warmup-setlists.json?warmup='+Date.now(),new URL('../data/warmup-setlists.json',import.meta.url).href])try {
      const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(r.ok)return await r.json();
    }catch{}
    snapshot=null;return null;
  })();
  return snapshot;
}
export function mountWarmupSetlist(host,concert,artist,archive) {
  const details=document.createElement('details');details.className='warmup-setlist';
  details.innerHTML='<summary><span>Setlist <small></small></span><span aria-hidden="true">⌄</span></summary><div class="warmup-setlist-content"></div><p class="footnote" role="status" aria-live="polite"></p><button type="button" class="plain-act" hidden>Refresh setlist</button>';
  host.append(details);
  const body=details.querySelector('.warmup-setlist-content'),badge=details.querySelector('small'),status=details.querySelector('[role="status"]'),refresh=details.querySelector('button');
  let loaded=false,busy=false,pending=null,timer=null;
  const own=data=>Object.values(data?.concerts?.[concert.id]?.artists||{}).find(r=>r.targetIdentity===warmupIdentity(concert,r.artist)&&warmupArtistKey(r.artist)===warmupArtistKey(artist)&&r.lastAttemptAt);
  const render=data=>{
    const r=selectWarmupReference(concert,artist,data,archive,today());
    badge.textContent=r?(sameTourReference(r)?'Same tour':'Recent show'):'';
    if(!r)body.innerHTML=`<p class="footnote">No recent setlist available yet.</p><a class="plain-act" href="https://www.setlist.fm/search?query=${encodeURIComponent(artist)}" target="_blank" rel="noopener noreferrer">Search setlist.fm ↗</a>`;
    else {
      const source=r.sourceEvent,sets=r.sets.map(s=>({name:s.name,songs:(s.songs||[]).filter(n=>typeof n==='string'&&n.trim())})).filter(s=>s.songs.length);
      let number=0;
      body.innerHTML=`<p class="footnote">${esc([source.date,source.venue,source.city].filter(Boolean).join(' · '))}${source.tour?`<br>Tour: ${esc(source.tour)}`:''}</p><p class="footnote">Reference from another show. Songs may change at your concert.</p>${sets.map(set=>{
        const start=number;number+=set.songs.length;
        return `<div class="setlist-block">${sets.length>1||/encore/i.test(set.name)?`<p class="setlist-name">${esc(set.name)}</p>`:''}<ol class="setlist-songs" style="counter-reset:song ${start}">${set.songs.map(song=>`<li>${esc(song)}</li>`).join('')}</ol></div>`;
      }).join('')}<a class="plain-act" href="${esc(referenceURL(r.sourceUrl))}" target="_blank" rel="noopener noreferrer">Source · setlist.fm ↗</a>`;
    }
    refresh.hidden=false;
  };
  async function poll(until=Date.now()+10*60000) {
    clearTimeout(timer);
    if(!pending||!details.isConnected||!details.open)return;
    try {
      const {json}=await getFile(pending.config,'data/warmup-setlists.json');
      if(!details.isConnected)return;
      const result=own(json);
      if(result?.requestId===pending.request.requestId) {
        snapshot=Promise.resolve(json);pending=null;busy=false;refresh.disabled=false;
        render(json);status.textContent=result.lastError?'Could not complete the search. You can try Refresh setlist.':'Saved for next time.';return;
      }
    }catch{}
    if(Date.now()>=until){status.textContent='Search is still pending. Reopen this setlist later.';busy=false;refresh.disabled=false;return;}
    if(details.open)timer=setTimeout(()=>poll(until),10000);
  }
  async function start(force=false) {
    if(busy)return;
    busy=true;refresh.disabled=true;status.textContent='Loading saved setlist…';
    try {
      const data=await loadSnapshot();loaded=true;
      if(!details.isConnected)return;
      render(data);
      const saved=own(data);
      if(saved&&!force){status.textContent=saved.lastError?'Last search was unavailable. Use Refresh setlist to retry.':'';return;}
      if(!details.open){loaded=false;return;}
      const config=getGithubConfig();
      if(!config?.token){status.textContent='Connect GitHub in the app settings to search and save this setlist.';return;}
      status.textContent='Requesting setlist search…';
      const result=await requestWarmupSetlist(config,concert,artist,{force});
      if(result.data){snapshot=Promise.resolve(result.data);render(result.data);status.textContent='';return;}
      pending={config,request:result.request};status.textContent='Searching in the background. The first result may take a little while.';
      poll();
    }catch(e){status.textContent=e.status?'Could not request the search. Check your GitHub connection.':e.message;}
    finally{busy=false;refresh.disabled=!!pending;}
  }
  details.addEventListener('toggle',()=>{
    if(!details.open){clearTimeout(timer);return;}
    if(pending){status.textContent='Waiting for the saved search result…';poll();}
    else if(!loaded)start();
  });
  refresh.addEventListener('click',event=>{event.stopPropagation();start(true);});
}
