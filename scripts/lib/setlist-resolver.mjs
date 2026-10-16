import { countryCode, locationKey } from '../../js/concert-countries.js';

export const artistKey = value => String(value || '').normalize('NFKD')
  .replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export const targetIdentity = (c, artist) =>
  JSON.stringify([artist,c.date,c.venue,c.city,c.country]);

export function setlistURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password
      && ['setlist.fm','www.setlist.fm'].includes(u.hostname) ? u.href : null;
  } catch { return null; }
}

const iso = value => {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(value || ''));
  if (!match) return null;
  const date = `${match[3]}-${match[2]}-${match[1]}`;
  const time = Date.parse(date + 'T12:00:00Z');
  return Number.isFinite(time)
    && new Date(time).toISOString().slice(0,10) === date ? date : null;
};

const fmDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
  ? value.split('-').reverse().join('-') : '';

const distance = (date, target) =>
  Math.abs(Date.parse(date + 'T12:00Z') - Date.parse(target + 'T12:00Z')) / 86400000;

const compatibleVenue = (a,b) => {
  const x = artistKey(a), y = artistKey(b);
  return !!x && !!y && (x === y || x.startsWith(y + ' ')
    || y.startsWith(x + ' ') || x.endsWith(' ' + y) || y.endsWith(' ' + x));
};

export function exactEvent(c, artist, item) {
  if (!item?.id || !setlistURL(item.url) || !artistKey(artist)
    || artistKey(item.artist?.name) !== artistKey(artist)
    || iso(item.eventDate) !== c.date) return false;

  const country = countryCode(c.country);
  const other = countryCode(item.venue?.city?.country?.code
    || item.venue?.city?.country?.name);
  if (country && other && country !== other) return false;

  const city = !!locationKey(c.city)
    && locationKey(c.city) === locationKey(item.venue?.city?.name);
  if (locationKey(c.city) && locationKey(item.venue?.city?.name) && !city) return false;

  const venue = compatibleVenue(c.venue, item.venue?.name);
  if (c.venue && item.venue?.name && !venue) {
    return !!c.isFestival && city && !!country && country === other
      && /\b(stage|tent|festival|weide|terrein)\b/i.test(item.venue.name);
  }
  return city || venue;
}

export function extractSets(item) {
  const raw = item?.sets?.set ?? item?.set;
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((set,i) => {
    const songs = Array.isArray(set.song) ? set.song : set.song ? [set.song] : [];
    return {
      name: String(set.name || (set.encore ? `Encore ${set.encore}`
        : i ? `Set ${i+1}` : 'Set')),
      songs: songs.map(s => typeof s === 'string' ? s : s?.name)
        .filter(s => typeof s === 'string' && s.trim()).map(s=>s.trim())
    };
  }).filter(set=>set.songs.length);
}

function saved(c, artist, item, matchType, evidence) {
  const sets = extractSets(item);
  return {
    artist, sets, songCount: sets.reduce((n,s)=>n+s.songs.length,0),
    sourceUrl: setlistURL(item.url), setlistFmId: item.id,
    matchingVersion: 2, matchType, targetIdentity: targetIdentity(c,artist),
    tourEvidence: evidence || null,
    sourceEvent: {
      artist:item.artist.name, date:iso(item.eventDate),
      venue:item.venue?.name || '', city:item.venue?.city?.name || '',
      country:item.venue?.city?.country?.code || '', tour:item.tour?.name || ''
    }
  };
}

export async function resolveSetlist(c, artist, get, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0,10);
  if (!fmDate(c.date) || iso(fmDate(c.date)) !== c.date)
    throw new Error('Invalid concert date');

  const search = async params => {
    const u = new URL('https://api.setlist.fm/rest/1.0/search/setlists');
    for (const [key,value] of Object.entries(params))
      if (value) u.searchParams.set(key,String(value));
    const json = await get(u.href);
    if (json === null) return { items:[], more:false };
    if (!json || !Object.hasOwn(json,'setlist'))
      throw new Error('Unexpected setlist search response');
    const items = Array.isArray(json.setlist)
      ? json.setlist : json.setlist ? [json.setlist] : [];
    return {
      items,
      more: Number(json.page) * Number(json.itemsPerPage) < Number(json.total)
    };
  };

  const hydrate = async item => {
    if (extractSets(item).length) return item;
    const full = await get('https://api.setlist.fm/rest/1.0/setlist/'
      + encodeURIComponent(item.id));
    if (full === null) return item;
    if (full.id !== item.id) throw new Error('Wrong setlist detail response');
    return full;
  };

  const anchors = new Map();
  for (const cityName of [c.city, null]) {
    const {items} = await search({
      artistName:artist,date:fmDate(c.date),cityName,p:1
    });
    for (const item of items)
      if (exactEvent(c,artist,item)) anchors.set(item.id,item);
    if (anchors.size || !c.city) break;
  }

  if (anchors.size > 1) return null;
  let anchor = [...anchors.values()][0];
  if (anchor) {
    anchor = await hydrate(anchor);
    if (!exactEvent(c,artist,anchor))
      throw new Error('Event details changed identity');
    if (extractSets(anchor).length) return saved(c,artist,anchor,'exact');
  }

  const explicitTour = artistKey(artist) === artistKey(c.artist)
    ? c.tourName || c.tour?.name : null;
  const tour = anchor?.tour?.name || explicitTour;
  if (!artistKey(tour)) return null;

  const evidence = anchor
    ? {kind:'target-event',id:anchor.id,tour}
    : {kind:'concert-tour',tour};

  const options = new Map();
  for (let p=1;p<=3;p++) {
    const response = await search({artistName:artist,tourName:tour,p});
    for (const item of response.items) {
      const date = iso(item.eventDate), gap = date && distance(date,c.date);
      if (item.id && setlistURL(item.url)
        && artistKey(item.artist?.name) === artistKey(artist)
        && artistKey(item.tour?.name) === artistKey(tour)
        && date <= today && gap > 0 && gap <= 60)
        options.set(item.id,{item,gap});
    }
    if (!response.more) break;
  }

  const candidates = [...options.values()].sort((a,b)=>
    a.gap-b.gap || String(a.item.id).localeCompare(String(b.item.id)));

  for (const {item} of candidates.slice(0,3)) {
    const full = await hydrate(item), date = iso(full.eventDate);
    if (artistKey(full.artist?.name) !== artistKey(artist)
      || artistKey(full.tour?.name) !== artistKey(tour)
      || !date || date > today || distance(date,c.date) <= 0
      || distance(date,c.date) > 60 || !setlistURL(full.url)) continue;
    if (extractSets(full).length)
      return saved(c,artist,full,'tour-reference',evidence);
  }
  return null;
}

export function shouldCheckSetlist(previous, c, artist, now = Date.now()) {
  if (!previous) return true;
  if (previous.lastError && now-Date.parse(previous.lastAttemptAt) < 3600000)
    return false;
  if (previous.targetIdentity !== targetIdentity(c,artist)
    || previous.matchingVersion !== 2) return true;
  if (previous.matchType === 'exact' && previous.sets?.length) return false;

  const recent = now-Date.parse(c.date+'T12:00Z') < 30*86400000;
  const interval = previous.matchType === 'tour-reference' || recent
    ? 86400000 : 7*86400000;
  const age = now-Date.parse(previous.lastExactCheckAt || previous.checkedAt);
  return !Number.isFinite(age) || age >= interval;
}
