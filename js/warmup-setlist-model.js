export const warmupArtistKey=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function warmupArtists(c) {
  const s=c.schedule?.date===c.date?c.schedule:null;
  const names=c.isFestival ? (c.lineup || []) : [s?.main?.name||c.artist,...(s?.noSupport?[]:[...(c.supportingArtists||[]),...(s?.support||[]).map(a=>a.name)])];
  return [...new Map(names
    .filter(n=>typeof n==='string'&&n.trim()&&!/^(support|support act|voorprogramma|tba|unknown|nog niet bekend)$/i.test(n.trim()))
    .map(n=>[warmupArtistKey(n),n.trim()])).values()];
}
export function referenceDate(raw) {
  const m=/^(\d{2})-(\d{2})-(\d{4})$/.exec(String(raw||''));
  const date=m?`${m[3]}-${m[2]}-${m[1]}`:String(raw||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;
  const stamp=Date.parse(date+'T12:00Z');
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===date?date:null;
}
export function referenceURL(raw) {
  try {const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&['setlist.fm','www.setlist.fm'].includes(u.hostname)?u.href:null;}catch{return null;}
}
export function validWarmupReference(r,artist,today,maxAgeDays=180) {
  const date=referenceDate(r?.sourceEvent?.date),cutoff=Date.parse(today+'T12:00Z')-maxAgeDays*86400000;
  return !!r && ['exact','tour-reference','similar-show','recent-reference'].includes(r.matchType)
    && warmupArtistKey(r.artist)===warmupArtistKey(artist)
    && warmupArtistKey(r.sourceEvent?.artist)===warmupArtistKey(artist)
    && !!date && date<=today && Date.parse(date+'T12:00Z')>=cutoff
    && !!referenceURL(r.sourceUrl) && Array.isArray(r.sets)
    && r.sets.some(s=>Array.isArray(s?.songs)&&s.songs.some(n=>typeof n==='string'&&n.trim()));
}
export function sameTourReference(r) {
  return r?.matchType==='tour-reference' && ['target-event','concert-tour'].includes(r.tourEvidence?.kind)
    && !!warmupArtistKey(r.sourceEvent?.tour)
    && warmupArtistKey(r.sourceEvent.tour)===warmupArtistKey(r.tourEvidence?.tour);
}
export function selectWarmupReference(c,artist,snapshot,archive,today) {
  const rows=Object.values(snapshot?.concerts?.[c.id]?.artists||{});
  const own=rows.find(r=>warmupArtistKey(r.artist)===warmupArtistKey(artist)
    && r.targetIdentity===JSON.stringify([r.artist,c.date,c.venue,c.city,c.country])
    && validWarmupReference(r,artist,today,Infinity) && r.sourceEvent.date<c.date);
  if(own)return own;
  const fallback=[...(archive?.values?.()||[])].flatMap(e=>e.artists?Object.values(e.artists):[e])
    .filter(r=>r.matchingVersion>=4 && validWarmupReference(r,artist,today) && r.sourceEvent.date<c.date)
    .sort((a,b)=>b.sourceEvent.date.localeCompare(a.sourceEvent.date))[0];
  // Evidence of a tour for a past concert does not establish the upcoming tour.
  return fallback?{...fallback,matchType:'recent-reference',tourEvidence:null}:null;
}

export const warmupIdentity=(c,artist)=>JSON.stringify([artist,c.date,c.venue,c.city,c.country]);
export const warmupRequestKey=(c,artist)=>c.id+'::'+warmupArtistKey(artist);
export function pendingWarmupRequests(planned,requests,store,now=Date.now()) {
  const today=new Date(now).toISOString().slice(0,10),out=[];
  for(const [requestKey,r]of Object.entries(requests.requests||{})) {
    const c=planned.concerts.find(c=>c.id===r?.concertId);
    if(!c||c.date<today||typeof r.artist!=='string'||!r.requestId)continue;
    if(requestKey!==warmupRequestKey(c,r.artist)||r.identity!==warmupIdentity(c,r.artist))continue;
    const age=now-Date.parse(r.requestedAt);
    if(!Number.isFinite(age)||age<0||age>86400000)continue;
    if(!warmupArtists(c).some(a=>warmupArtistKey(a)===warmupArtistKey(r.artist)))continue;
    const old=store.concerts?.[c.id]?.artists?.[warmupArtistKey(r.artist)];
    if(old?.requestId===r.requestId&&old.targetIdentity===r.identity)continue;
    out.push({c,artist:r.artist,old,request:r});
  }
  return out.sort((a,b)=>a.request.requestedAt.localeCompare(b.request.requestedAt));
}


// Daily near-show checks are deliberately bounded. They complement (and
// never replace) explicit on-demand requests for support/festival artists.
export function automaticWarmupCandidates(planned,store,now=Date.now()) {
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Amsterdam',
    year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const start=Date.parse(today+'T12:00Z');
  const queue=[];
  for(const c of planned?.concerts||[]) {
    if(!c?.id||!referenceDate(c.date)||c.isFestival)continue;
    const gap=Math.round((Date.parse(c.date+'T12:00Z')-start)/86400000);
    if(gap<0||gap>7)continue;
    // Only the headline act is automatic. Support acts can be requested
    // individually, without exhausting the setlist.fm API allowance.
    const artist=warmupArtists(c)[0];
    if(!artist)continue;
    const identity=warmupIdentity(c,artist);
    const old=store?.concerts?.[c.id]?.artists?.[warmupArtistKey(artist)];
    const age=now-Date.parse(old?.lastAttemptAt||'');
    if(old?.targetIdentity===identity&&Number.isFinite(age)&&age>=0&&age<23*3600000)continue;
    queue.push({c,artist,old,automatic:true,gap});
  }
  return queue.sort((a,b)=>a.gap-b.gap||String(a.old?.lastAttemptAt||'').localeCompare(String(b.old?.lastAttemptAt||'')));
}
