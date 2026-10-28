export const warmupArtistKey=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function warmupArtists(c) {
  const s=c.schedule?.date===c.date?c.schedule:null;
  return [...new Map([s?.main?.name||c.artist,...(s?.noSupport?[]:[...(c.supportingArtists||[]),...(s?.support||[]).map(a=>a.name)])]
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
