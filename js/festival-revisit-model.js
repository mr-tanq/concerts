// A festival can return to Deciding only after a *new* confirmed artist
// is added to its lineup since the user's last Pass. "Liked" means an artist
// with real listening history, not a similar-artist suggestion.
const supportedSource=s=>['festivalinfo','officialfestival'].includes(s);
const key=value=>String(value||'').normalize('NFKD')
  .replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

export function festivalLineupRevisit(event,dismissed,signalByName,minPlaycount=5) {
  if(event?.isFestival!==true||!supportedSource(event.source)
    ||!event.concertId||!dismissed || dismissed.source!==event.source
    ||String(dismissed.sourceId)!==String(event.concertId)
    ||!dismissed.dismissedAt || !Number.isFinite(Date.parse(dismissed.dismissedAt))
    ||!Array.isArray(event.lineup)||!Array.isArray(dismissed.lineup)
    ||!dismissed.lineup.length||!event.date||!dismissed.date
    ||event.date.slice(0,4)!==dismissed.date.slice(0,4))return null;
  const before=new Set(dismissed.lineup.map(key).filter(Boolean));
  const fresh=new Map();
  for(const artist of event.lineup) {
    const k=key(artist),signal=signalByName.get(k);
    if(!k||before.has(k)||!signal||!(Number(signal.playcount)>minPlaycount))continue;
    if(!fresh.has(k))fresh.set(k,{name:artist,playcount:Number(signal.playcount)});
  }
  if(!fresh.size)return null;
  const newMatchingArtists=[...fresh.values()]
    .sort((a,b)=>b.playcount-a.playcount||a.name.localeCompare(b.name))
    .map(x=>x.name);
  return {
    kind:'new-liked-artist',dismissedAt:dismissed.dismissedAt,
    newMatchingArtists,previousLineupCount:before.size,
    currentLineupCount:new Set(event.lineup.map(key)).size
  };
}

// Defense in depth: old cached recommendation files must not bypass a new Pass.
// The latest dismissal snapshot always wins. No resurface if already planned.
export function canShowFestivalRevisit(rec,history) {
  if(rec?.isFestival!==true||!supportedSource(rec.source)
    ||rec.festivalUpdate?.kind!=='new-liked-artist'
    ||!Array.isArray(rec.festivalUpdate.newMatchingArtists)
    ||!rec.festivalUpdate.newMatchingArtists.length
    ||history?.plannedIds?.includes(rec.id))return false;
  const dismissed=(history?.dismissed||[]).find(d=>d.id===rec.id);
  if(!dismissed || dismissed.dismissedAt!==rec.festivalUpdate.dismissedAt
    ||!Array.isArray(dismissed.lineup)||!Array.isArray(rec.lineup))return false;
  const baseline=new Set(dismissed.lineup.map(key));
  const current=new Set(rec.lineup.map(key));
  return rec.festivalUpdate.newMatchingArtists.every(a=>
    !baseline.has(key(a))&&current.has(key(a)));
}

export const sameFestivalUpdate=(a,b)=>
  !!a&&!!b&&a.dismissedAt===b.dismissedAt
  &&JSON.stringify(a.newMatchingArtists)===JSON.stringify(b.newMatchingArtists);
