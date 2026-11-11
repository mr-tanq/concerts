// Shared by Node discovery and the mobile app. A poster explicitly marked
// with a different year must never be shown for this festival edition.
export function festivalArtworkMatchesEdition(raw, date) {
  if(typeof raw!=='string'||!raw.trim())return false;
  const year=String(date||'').slice(0,4);
  if(!/^20\d\d$/.test(year))return false;
  let url;
  try {
    url=new URL(raw);
    if(url.protocol!=='https:'||url.username||url.password)return false;
  }catch{return false;}
  const filename=decodeURIComponent(url.pathname.split('/').at(-1)||'');
  const years=[...filename.matchAll(/(?:^|[^\d])(20\d{2})(?!\d)/g)].map(m=>m[1]);
  return !years.length||years.every(y=>y===year);
}

export function editionArtworkScore(raw, date, label='') {
  if(!festivalArtworkMatchesEdition(raw,date))return -1;
  const year=String(date).slice(0,4);
  const filename=new URL(raw).pathname.split('/').at(-1)||'';
  // A news caption with the wrong edition year is contradictory evidence.
  const words=String(label||'');
  const labelYears=[...words.matchAll(/(?:^|[^\d])(20\d{2})(?!\d)/g)].map(m=>m[1]);
  if(labelYears.length&&!labelYears.every(y=>y===year))return -1;
  return filename.includes(year)||labelYears.includes(year)?2:1;
}
