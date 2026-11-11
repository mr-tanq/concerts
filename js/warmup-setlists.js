import {selectWarmupReference,sameTourReference,referenceURL,warmupArtistKey,warmupIdentity} from './warmup-setlist-model.js?v=festival-discovery-20261031';
import {requestWarmupSetlist} from './warmup-setlist-request.js?v=festival-discovery-20261031';
import {getGithubConfig,getFile} from './github-api.js';
import {buildSetlistGuide} from './setlist-prediction.js?v=setlist-guide-20261111';
let snapshot,snapshotAt=0;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function loadSnapshot(force=false) {
  if(force||Date.now()-snapshotAt>30*60000)snapshot=null;
  snapshot ||= (async()=>{
    for(const url of ['https://raw.githubusercontent.com/mr-tanq/concerts/main/data/warmup-setlists.json?warmup='+Date.now(),new URL('../data/warmup-setlists.json',import.meta.url).href])try {
      const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(r.ok){snapshotAt=Date.now();return await r.json();}
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
  let loaded=false,loadedAt=0,busy=false,pending=null,timer=null;
  const own=data=>Object.values(data?.concerts?.[concert.id]?.artists||{}).find(r=>r.targetIdentity===warmupIdentity(concert,r.artist)&&warmupArtistKey(r.artist)===warmupArtistKey(artist)&&r.lastAttemptAt);
  const render=data=>{
    const reference=selectWarmupReference(concert,artist,data,archive,today());
    const guide=buildSetlistGuide(reference,artist,today(),concert.date);
    badge.textContent=guide.showCount?(sameTourReference(reference)?'Same tour · ':'Guide · ')+guide.showCount+' shows':'';
    if(!guide.showCount) {
      body.innerHTML='<p class="footnote">No reliable recent setlists found yet.</p>'
        +'<a class="plain-act" href="https://www.setlist.fm/search?query='+encodeURIComponent(artist)+'" target="_blank" rel="noopener noreferrer">Search setlist.fm ↗</a>';
    } else {
      const plural=guide.showCount===1?'show':'shows';
      let html='<p class="footnote">Songs played at '+guide.showCount+' earlier '+plural+'. This is a guide, not the running order or a promise for your concert.</p>';
      if(guide.stale)html+='<p class="footnote">Only an older example is available (over 180 days old). This is NOT a current setlist prediction.</p>';
      else if(guide.limited)html+='<p class="footnote">Limited evidence: fewer than 3 documented shows. Treat this as an example, not a reliable prediction.</p>';
      else html+='<p class="footnote">Counts show what happened at previous concerts, NOT the probability of hearing each song.</p>';
      if(guide.festivalMix)html+='<p class="footnote">Some sources are festival sets; those may be shorter than a headline show.</p>';
      if(concert.date<today())html+='<p class="footnote">This date has passed. Check the Archive for the actual setlist once verified.</p>';
      const sections=guide.showCount<2
        ?[['Songs from the reference show',guide.songs]]
        :[['Played most often',guide.songs.filter(s=>s.count/guide.showCount>=.75)],
          ['Played sometimes',guide.songs.filter(s=>s.count/guide.showCount>=.4&&s.count/guide.showCount<.75)],
          ['Less frequent',guide.songs.filter(s=>s.count/guide.showCount<.4)]];
      for(const [heading,songs]of sections) {
        if(!songs.length)continue;
        html+='<div class="setlist-block"><p class="setlist-name">'+esc(heading)+'</p><ul class="setlist-evidence">';
        for(const song of songs)html+='<li><span>'+esc(song.name)+'</span><span class="setlist-evidence-count">'+(guide.showCount===1?'1 reference':esc(song.observed))+'</span></li>';
        html+='</ul></div>';
      }
      html+='<details class="setlist-evidence-sources"><summary>Source concerts ('+guide.showCount+')</summary><ul>';
      for(const ref of guide.sources){
        const event=ref.sourceEvent||{};
        const title=[event.date,event.venue,event.city].filter(Boolean).join(' · ');
        html+='<li><a href="'+esc(referenceURL(ref.sourceUrl))+'" target="_blank" rel="noopener noreferrer">'+esc(title||'Source show')+'</a>'+(event.tour?' · '+esc(event.tour):'')+'</li>';
      }
      html+='</ul></details>';
      body.innerHTML=html;
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
        snapshot=Promise.resolve(json);snapshotAt=Date.now();pending=null;busy=false;refresh.disabled=false;
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
      const data=await loadSnapshot(force);loaded=true;loadedAt=Date.now();
      if(!details.isConnected)return;
      render(data);
      const saved=own(data);
      if(saved&&!force){status.textContent=saved.lastError?'Last search was unavailable. Use Refresh setlist to retry.':'';return;}
      if(!details.open){loaded=false;return;}
      const config=getGithubConfig();
      if(!config?.token){status.textContent='Setlists refresh automatically before your show. Connect GitHub for a manual search.';return;}
      status.textContent='Requesting setlist search…';
      const result=await requestWarmupSetlist(config,concert,artist,{force});
      if(result.data){snapshot=Promise.resolve(result.data);snapshotAt=Date.now();render(result.data);status.textContent='';return;}
      pending={config,request:result.request};status.textContent='Searching in the background. The first result may take a little while.';
      poll();
    }catch(e){status.textContent=e.status?'Could not request the search. Check your GitHub connection.':e.message;}
    finally{busy=false;refresh.disabled=!!pending;}
  }
  details.addEventListener('toggle',()=>{
    if(!details.open){clearTimeout(timer);return;}
    if(pending){status.textContent='Waiting for the saved search result…';poll();}
    else if(!loaded||Date.now()-loadedAt>30*60000)start();
  });
  refresh.addEventListener('click',event=>{event.stopPropagation();start(true);});
}
