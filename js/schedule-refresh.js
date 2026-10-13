import {getGithubConfig, getFile, putFile, isConflictError} from './github-api.js';
const PATH = 'data/planned.json';
export async function requestScheduleRefresh(config, id, now = Date.now()) {
  for (let attempt=0; attempt<3; attempt++) {
    const {json,sha} = await getFile(config, PATH);
    const c = json.concerts?.find(c=>c.id===id);
    if (!c) throw new Error('This concert is no longer in Going.');
    const s = c.schedule?.date===c.date ? c.schedule : {date:c.date};
    const requested=Date.parse(s.refreshRequestedAt), checked=Date.parse(s.lastAttemptAt);
    if (Number.isFinite(requested) && (!Number.isFinite(checked) || requested>checked) && now-requested<10*60000) return {requestedAt:s.refreshRequestedAt};
    const recent=Math.max(Number.isFinite(requested)?requested:0,Number.isFinite(checked)?checked:0);
    if (now-recent<5*60000) throw new Error('Please wait five minutes between checks.');
    const requestedAt=new Date(now).toISOString();
    c.schedule={...s,refreshRequestedAt:requestedAt};
    try {await putFile(config,PATH,json,sha,'chore: request concert schedule refresh (app)');return {requestedAt};}
    catch(e){if(!isConflictError(e)||attempt===2) throw e;}
  }
}
export function attachScheduleRefresh(host, concert, onUpdate) {
  const button=host.querySelector?.('[data-refresh-schedule]');
  const status=host.querySelector?.('[data-refresh-status]');
  if (!button?.addEventListener || !status) return ()=>{};
  let stopped=false, timeout=null;
  const say=text=>{status.textContent=text;};
  async function poll(config,requestedAt,until) {
    if(stopped || !host.isConnected) return;
    try {
      const {json}=await getFile(config,PATH);
      if(stopped || !host.isConnected) return;
      const fresh=json.concerts?.find(c=>c.id===concert.id);
      if(!fresh){say('This concert is no longer in Going.');return;}
      if(Date.parse(fresh.schedule?.lastAttemptAt)>=Date.parse(requestedAt)) {onUpdate(fresh);return;}
    } catch { if(!stopped) say('Waiting for the check. Connection temporarily unavailable.'); }
    if(stopped)return;
    if(Date.now()>=until){say('The check is taking longer than expected. Reopen this card later.');button.disabled=false;return;}
    timeout=setTimeout(()=>poll(config,requestedAt,until),10000);
  }
  button.addEventListener('click',async()=>{
    const config=getGithubConfig();
    if(!config?.token){say('Connect GitHub in the app settings to request a check.');return;}
    button.disabled=true;say('Requesting a new check…');
    try {
      const {requestedAt}=await requestScheduleRefresh(config,concert.id);
      if(stopped)return;
      concert.schedule={...concert.schedule,date:concert.date,refreshRequestedAt:requestedAt};
      say('Check requested. Waiting for the result…');
      poll(config,requestedAt,Date.now()+10*60000);
    } catch(e){if(!stopped){say(e.status?'Could not request a check. Check your GitHub connection.':e.message);button.disabled=false;}}
  });
  const requested=concert.schedule?.refreshRequestedAt;
  if(Date.parse(requested)>Date.parse(concert.schedule?.lastAttemptAt || 0) && Date.now()-Date.parse(requested)<10*60000){
    const config=getGithubConfig();
    if(config?.token){button.disabled=true;say('Check requested. Waiting for the result…');poll(config,requested,Date.parse(requested)+10*60000);}
  }
  return ()=>{stopped=true;clearTimeout(timeout);};
}
