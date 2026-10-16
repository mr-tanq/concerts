const key = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu,'')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

const plain = html => html.replace(/<[^>]*>/g,'').replace(
  /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (all, entity) => {
    const known={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '};
    if (entity[0]!=='#') return known[entity.toLowerCase()] || all;
    const n=entity[1].toLowerCase()==='x'
      ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return n>0 && n<=0x10ffff ? String.fromCodePoint(n) : all;
  }).trim();

function venueURL(value) {
  try {
    const u=new URL(value);
    return u.protocol==='https:' && !u.username && !u.password
      && ['setlist.fm','www.setlist.fm'].includes(u.hostname)
      && /^\/venue\/[a-z0-9-]+\.html$/i.test(u.pathname) ? u : null;
  } catch { return null; }
}

function selectedVenue(u) {
  return u.searchParams.get('venue')
    || /-([a-f0-9]+)\.html$/i.exec(u.pathname)?.[1];
}

export function parseVenueParent(html, finalURL, venue) {
  const page=venueURL(finalURL);
  if (!venue?.id || !page || selectedVenue(page)!==venue.id) return null;

  const heading=plain(
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || ''
  );
  const matches=[...html.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>((?:(?!<\/a>)[\s\S])*)<\/a>\s*\(main venue\)/gi
  )];
  if (matches.length!==1) return null;

  const parent=venueURL(new URL(plain(matches[0][1]),page).href);
  const name=plain(matches[0][2]);
  if (!parent || !name || selectedVenue(parent)===venue.id
    || !key(heading).startsWith(key(`${venue.name} at ${name}`)+' '))
    return null;

  return {
    name,url:parent.href,sourceUrl:page.href,childId:venue.id
  };
}

export function createVenueParentLookup(getPage=async url=>{
  const response=await fetch(url,{
    headers:{
      Accept:'text/html',
      'Accept-Language':'en',
      'User-Agent':'ListeningMirror/2.0'
    },
    signal:AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Venue page HTTP ${response.status}`);
  return {html:await response.text(),url:response.url};
}) {
  const cache=new Map();
  let lastCall=0;

  return async venue=>{
    const u=venueURL(venue?.url);
    if (!venue?.id || !u || selectedVenue(u)!==venue.id) return null;
    const cacheKey=JSON.stringify([venue.id,venue.name,u.href]);

    if (!cache.has(cacheKey)) cache.set(cacheKey,(async()=>{
      await new Promise(resolve=>setTimeout(
        resolve,Math.max(0,650-(Date.now()-lastCall))
      ));
      lastCall=Date.now();
      const page=await getPage(u.href);
      return parseVenueParent(page.html,page.url,venue);
    })());

    return cache.get(cacheKey);
  };
}
