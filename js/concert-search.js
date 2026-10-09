import { getGithubConfig, getFile, putFile, isConflictError } from './github-api.js';
import { validateSearchRequest } from './concert-search-model.js?v=nationwide-search-20261009';
const REQUEST_PATH = 'data/concert-search-request.json';
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
export async function submitConcertSearch(config, request) {
  validateSearchRequest(request);
  for (let attempt=0; attempt<4; attempt++) {
    let sha;
    try { sha=(await getFile(config,REQUEST_PATH)).sha; } catch(error) { if(error.status !== 404) throw error; }
    try { await putFile(config,REQUEST_PATH,request,sha,`chore: search concerts ${request.id} (app)`); return; }
    catch(error) { if (!isConflictError(error) || attempt===3) throw error; await delay(250*(attempt+1)); }
  }
}
export async function readConcertSearch(config, id) {
  const {json} = await getFile(config,`data/concert-search-results/${id}.json`);
  if (json.requestId !== id || !['complete','error'].includes(json.status)) throw new Error('Unexpected search result. Please try again.');
  return json;
}
const safeLink = value => { try { const u=new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } };

export function openConcertSearch({ button, stateFor, addConcert, showDeciding, connect, api = { submit:submitConcertSearch, read:readConcertSearch }, pollMs = 7000, timeoutMs = 600000 }) {
  const config = getGithubConfig();
  if (!config) { connect(); return; }
  if (document.querySelector('dialog.concert-search')) return;
  const storageKey = `lm_concert_search:${config.owner}/${config.repo}`;
  const dialog = document.createElement('dialog'); dialog.className='concert-search';
  dialog.setAttribute('aria-labelledby','concert-search-title');
  dialog.innerHTML = `<div class="concert-search-head"><p class="whisper">Find a concert</p><button type="button" class="concert-search-close" aria-label="Close concert search">×</button></div>
    <h2 id="concert-search-title">Something missing?</h2>
    <p class="footnote">Find a show and add it to Deciding. You can choose Going or Pass afterwards.</p>
    <form class="concert-search-form">
      <div class="field"><label for="concert-search-artist">Artist or band</label><input id="concert-search-artist" name="artist" required minlength="2" maxlength="100" placeholder="Groundation" autocomplete="off"></div>
      <div class="field"><label for="concert-search-place">Venue or city (optional)</label><input id="concert-search-place" name="place" minlength="2" maxlength="120" placeholder="All Netherlands" autocomplete="off" aria-describedby="concert-search-scope"></div>
      <p id="concert-search-scope" class="footnote">Leave blank to search across the Netherlands, including venues outside our list.</p>
      <button type="submit" class="plain-act">Search</button>
    </form>
    <p class="concert-search-status footnote" role="status" aria-live="polite"></p>
    <div class="concert-search-results"></div>
    <button type="button" class="plain-act concert-search-deciding" hidden>Go to Deciding →</button>`;
  document.body.appendChild(dialog);
  const form=dialog.querySelector('form'), artist=form.elements.artist, place=form.elements.place;
  const submit=form.querySelector('[type="submit"]'), status=dialog.querySelector('[role="status"]'), results=dialog.querySelector('.concert-search-results'), deciding=dialog.querySelector('.concert-search-deciding');
  let generation=0, closed=false, busyAdding=false, wake=null, timer=null;
  const stopPoll=()=>{generation++;clearTimeout(timer);wake?.();wake=null;};
  const pause=()=>new Promise(resolve=>{wake=resolve;timer=setTimeout(()=>{wake=null;resolve();},pollMs);});
  const remember = value=>{ try {localStorage.setItem(storageKey,JSON.stringify(value));} catch {} };
  const say=(text,bad=false)=>{status.textContent=text;status.classList.toggle('bad',bad);};
  const node=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
  function showResults(result, request) {
    results.replaceChildren(); results.setAttribute('aria-busy','false');
    if (result.status==='error') {say(result.message || 'Search could not finish. Please try again.',true);return;}
    const concerts=Array.isArray(result.concerts) ? result.concerts : [];
    const scope = request.place ? '' : ' in the Netherlands';
    say(concerts.length ? `${concerts.length} ${concerts.length===1?'show':'shows'} found${scope}. Choose the date and venue you want.` : `No verified matches found${scope} in the next 12 months. Try the full artist name${request.place ? ' or another venue or city' : ''}.`);
    const warnings = Array.isArray(result.warnings) ? [...new Set(result.warnings.filter(w=>typeof w==='string' && w.trim()))] : [];
    if (warnings.length) {
      const coverage=node('details','','concert-search-coverage');
      coverage.appendChild(node('summary','Search may be incomplete','footnote'));
      for (const warning of warnings) coverage.appendChild(node('p',warning,'footnote concert-search-warning'));
      results.appendChild(coverage);
    }
    for (const c of concerts) {
      const row=node('div','','concert-search-result');
      row.append(node('h3',c.artist),node('p',`${c.venue} · ${c.city}`,'footnote'));
      if (c.supportingArtists?.length) row.appendChild(node('p',`With ${c.supportingArtists.join(' · ')}`,'footnote'));
      const date=new Date(`${c.date}T12:00:00Z`);
      row.appendChild(node('p',Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}).format(date):c.date,'concert-search-date'));
      const source=safeLink(c.officialUrl || c.sourceUrl);
      if (source) {const link=node('a',c.officialUrl || c.source==='official'?'Official event ↗':'Podiuminfo ↗','concert-search-source');link.href=source;link.target='_blank';link.rel='noopener noreferrer';row.appendChild(link);}
      const action=node('button',stateFor(c) || 'Add to Deciding','plain-act');action.type='button';action.disabled=!!stateFor(c);row.appendChild(action);
      if (action.textContent==='In Set aside') row.appendChild(node('p','You can bring this back from Set aside.','footnote'));
      action.addEventListener('click',async()=>{
        if (busyAdding) return;
        const current=stateFor(c);if(current){action.textContent=current;action.disabled=true;return;}
        busyAdding=true;submit.disabled=true;
        results.querySelectorAll('button').forEach(b=>b.disabled=true); action.textContent='Adding…';
        try {
          await addConcert({...c,manualSearch:{artist:request.artist,place:request.place,checkedAt:result.checkedAt,addedAt:new Date().toISOString()}});
          if(closed)return;
          action.textContent='Added to Deciding';deciding.hidden=false;say(`${c.artist} added. You can now choose Going or Pass.`);
          results.querySelectorAll('.concert-search-result').forEach((r,i)=>{const b=r.querySelector('button');b.disabled=!!stateFor(concerts[i]);if(b!==action && b.disabled)b.textContent=stateFor(concerts[i]);});
        } catch(error) {if(!closed){action.textContent=error.concertState || stateFor(c)||'Add to Deciding';say(error.message || 'Could not save this concert. Please try again.',true);results.querySelectorAll('.concert-search-result').forEach((r,i)=>r.querySelector('button').disabled=!!stateFor(concerts[i]));if(error.concertState)action.disabled=true;}}
        finally {busyAdding=false;submit.disabled=false;}
      });
      results.appendChild(row);
    }
  }
  async function poll(request, token) {
    const started=Date.now(); results.setAttribute('aria-busy','true');
    say(request.place ? 'Checking the concert sources… This can take a minute. You can close this window and return to Add.' : 'Checking concert sources across the Netherlands… This can take a few minutes. You can close this window and return to Add.');
    while(!closed && generation===token && Date.now()-started<timeoutMs) {
      try {
        const result=await api.read(config,request.id);
        if(closed || generation!==token)return;
        remember({...request,result});showResults(result,request);return;
      } catch(error) {
        if(closed || generation!==token)return;
        if(error.status!==404){say(error.message || 'Could not retrieve the search. Try again.',true);results.setAttribute('aria-busy','false');return;}
      }
      await pause();
    }
    if(!closed && generation===token){results.setAttribute('aria-busy','false');say('The search is taking longer than expected. Reopen Add to check again, or start a new search.',true);}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busyAdding || !form.reportValidity())return;
    stopPoll();const token=generation, request={id:crypto.randomUUID(),artist:artist.value.trim(),place:place.value.trim(),requestedAt:new Date().toISOString()};
    try {validateSearchRequest(request);}catch(error){say(error.message,true);return;}
    submit.disabled=true;deciding.hidden=true;results.replaceChildren();say('Starting your search…');
    try {
      await api.submit(config,request);remember(request);
      if(closed || generation!==token)return;
      submit.disabled=false;submit.textContent='Search again';await poll(request,token);
    } catch(error) {if(!closed && generation===token)say(error.message || 'Could not start the search. Please try again.',true);}
    finally {if(!closed && generation===token)submit.disabled=false;}
  });
  dialog.querySelector('.concert-search-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog){const b=dialog.getBoundingClientRect();if(event.clientX<b.left || event.clientX>b.right || event.clientY<b.top || event.clientY>b.bottom)dialog.close();}});
  dialog.addEventListener('close',()=>{closed=true;stopPoll();dialog.remove();if(button?.isConnected)button.focus({preventScroll:true});});
  deciding.addEventListener('click',()=>{dialog.close();showDeciding();});
  dialog.showModal();
  try {
    const previous=JSON.parse(localStorage.getItem(storageKey) || 'null');
    if(previous){validateSearchRequest(previous);artist.value=previous.artist;place.value=previous.place;if(previous.result)showResults(previous.result,previous);else void poll(previous,generation);}
  } catch {}
}
