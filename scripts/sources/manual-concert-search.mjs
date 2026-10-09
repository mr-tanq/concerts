import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { searchKey, sameSearchConcert, validateSearchRequest } from '../../js/concert-search-model.js';
import { searchCachedArtist, splitLineup, isTrackedName, normalizeArtistName, detectCountry } from './podiuminfo.mjs';
import { validDate, localDate } from '../../js/concert-schedule.js';
import { searchLocation, matchesLocation } from '../../js/concert-countries.js';
import { searchInternationalConcerts } from './international-concert-search.mjs';

// Only venue-owned sites. Location comes from Event data; registry defaults
// are used only by explicit, venue-specific single-event adapters.
export const SEARCH_VENUES = [
  ['Hall Of Fame','Tilburg','NL','hall-fame.nl','/programma'], ['Paard','Den Haag','NL','paard.nl','/agenda/'],
  ['TivoliVredenburg','Utrecht','NL','tivolivredenburg.nl','/agenda/'], ['013','Tilburg','NL','013.nl','/programma'],
  ['Paradiso','Amsterdam','NL','paradiso.nl','/programma'], ['Melkweg','Amsterdam','NL','melkweg.nl','/nl/agenda/'],
  ['Ziggo Dome','Amsterdam','NL','ziggodome.nl','/agenda'], ['Patronaat','Haarlem','NL','patronaat.nl','/programma/'],
  ['Doornroosje','Nijmegen','NL','doornroosje.nl','/programma/'], ['AFAS Live','Amsterdam','NL','afaslive.nl','/agenda'],
  ["dB's",'Utrecht','NL','dbstudio.nl','/events/'], ['Vera','Groningen','NL','vera-groningen.nl','/programma/'],
  ['Effenaar','Eindhoven','NL','effenaar.nl','/agenda'], ['Muziekgieterij','Maastricht','NL','muziekgieterij.nl','/'],
  ['Baroeg','Rotterdam','NL','baroeg.nl','/agenda/'], ['Annabel','Rotterdam','NL','annabel.nu','/agenda/'],
  ['Botanique','Brussels','BE','botanique.be','/en/concerts'], ['Bibelot','Dordrecht','NL','bibelot.net','/agenda/'],
  ['Grenswerk','Venlo','NL','grenswerk.nl','/agenda/'], ['Willemeen','Arnhem','NL','willemeen.nl','/programma/'],
];
const placeKey = value => searchKey(value).replace(/^tivoli vredenburg\b/, 'tivolivredenburg').replace(/^brussel$/, 'brussels');
export const placeMatches = (c, place) => [c.venue,c.city].some(v => placeKey(v).includes(placeKey(place)));
export function officialURL(value, domain, base) {
  try { const u = new URL(value, base); return u.protocol === 'https:' && !u.username && !u.password && [domain,`www.${domain}`].includes(u.hostname) ? u.href.split('#')[0] : null; } catch { return null; }
}
function safeURL(value) { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } }
function artistInTitle(title, artist) {
  const names = splitLineup(String(title).replace(/^(afgelast|cancelled|verplaatst)\s*[:–-]\s*/i,''), new Set([normalizeArtistName(artist)]));
  // An explicit tour subtitle after a dash is accepted; mentions in prose,
  // substring matches and tribute-to-another-band titles are not.
  return names.some(n => isTrackedName(n, new Set([normalizeArtistName(artist)])) ||
    isTrackedName(n.split(/\s+[-–—]\s+/)[0], new Set([normalizeArtistName(artist)])));
}
function eventDate(value, country) {
  if (typeof value !== 'string' || !validDate(value.slice(0,10))) return null;
  if (/T/.test(value) && /(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const ms = Date.parse(value); return Number.isFinite(ms) ? localDate(ms, country === 'BE' ? 'Europe/Brussels' : 'Europe/Amsterdam') : null;
  }
  return value.slice(0,10);
}
function namedDate(value) {
  const months = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  const short = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
  const m = searchKey(value).match(/\b(\d{1,2}) (\w+) (\d{4})\b/);
  if (!m) return null;
  const month = months.includes(m[2]) ? months.indexOf(m[2]) : short.indexOf(m[2]);
  if (month < 0) return null;
  const date = `${m[3]}-${String(month+1).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return validDate(date) ? date : null;
}
export function parseOfficialEvents(html, url, venue, artist) {
  const [name,city,country,domain] = venue, $ = cheerio.load(html), events = [], output = [];
  const collect = value => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== 'object') return;
    if ([value['@type']].flat().some(t => ['Event','MusicEvent'].includes(t))) events.push(value);
    for (const key of ['@graph','itemListElement','item','subEvent']) if (value[key]) collect(value[key]);
  };
  $('script[type="application/ld+json"]').each((_,n) => { try { collect(JSON.parse($(n).text())); } catch {} });
  for (const e of events) {
    if (/EventCancelled|EventPostponed/.test(e.eventStatus || '')) continue;
    const performers = [e.performer].flat().filter(Boolean).map(p => typeof p === 'string' ? p : p.name).filter(Boolean);
    if (!(performers.length ? performers.some(p => artistInTitle(p,artist)) : artistInTitle(e.name,artist))) continue;
    const location = Array.isArray(e.location) ? e.location[0] : e.location;
    if (!location || typeof location !== 'object' || !location.name || !location.address?.addressLocality) continue;
    const addressCountry = typeof location.address.addressCountry === 'object' ? location.address.addressCountry.name : location.address.addressCountry;
    const code = /^(BE|Belgium|België|Belgique)$/i.test(addressCountry || '') ? 'BE' : /^(NL|Netherlands|Nederland)$/i.test(addressCountry || '') ? 'NL' : !addressCountry ? detectCountry(location.address.addressLocality) || '??' : '??';
    const date = eventDate(e.startDate,code), sourceUrl = officialURL(e.url || url,domain,url);
    if (!date || !sourceUrl) continue;
    const rawImage = typeof e.image === 'string' ? e.image : Array.isArray(e.image) ? e.image[0] : e.image?.url;
    const tracked = new Set([normalizeArtistName(artist)]);
    const displayArtist = performers.find(p=>isTrackedName(p,tracked)) || splitLineup(String(e.name || artist),tracked).find(p=>isTrackedName(p,tracked)) || artist;
    output.push({ artist:displayArtist, eventName:e.name || displayArtist, lineup: performers.length ? performers : [displayArtist], supportingArtists: performers.filter(p => searchKey(p) !== searchKey(displayArtist)), date, venue: location.name, city: location.address.addressLocality, country: code, sourceUrl, image: safeURL(rawImage), ticketUrl: safeURL([e.offers].flat().find(o => o?.url)?.url) });
  }
  // Patronaat has WebPage JSON-LD, not MusicEvent. Its event info bar is the
  // date authority. Remote locations without a verified city are excluded.
  if (!output.length && domain === 'patronaat.nl' && /^\/event\/[^/]+\/?$/.test(new URL(url).pathname)) {
    const heading = $('h1').first().text().replace(/\s+/g,' ').trim();
    const room = $('.event__info-bar--remote-location').first().text().trim();
    const date = namedDate($('.event__info-bar--star-date').first().text());
    if (date && /^(Stage [123]|Patronaat)$/i.test(room) && artistInTitle(heading,artist) && !/afgelast|cancelled|geannuleerd/i.test(heading)) {
      const displayArtist = heading.split(/\s+[-–—]\s+/)[0].trim();
      output.push({ artist:displayArtist, eventName:heading, lineup:[displayArtist], supportingArtists:[], date, venue:name, city, country, sourceUrl:url, image:safeURL($('meta[property="og:image"]').attr('content')), ticketUrl:safeURL($('a.button--tickets').first().attr('href')) });
    }
  }
  // Effenaar's Event data names only the headliner and a room, without a
  // city. Its own bill confirms support acts; only its two in-house halls
  // can use the registered venue/city. Other locations remain unverified.
  if (!output.length && domain === 'effenaar.nl' && officialURL(url,domain) && /^\/agenda\/[^/]+\/?$/.test(new URL(url).pathname)) {
    const heading = $('h1.header-title').first().text().replace(/\s+/g,' ').trim();
    const subtitle = $('.header-subtitle').first().text().replace(/\s+/g,' ').trim();
    const support = subtitle.match(/(?:^|\|)\s*\+\s*(.+)$/)?.[1] || '';
    const lineup = [...new Map([...splitLineup(heading),...splitLineup(support)].map(n=>[searchKey(n),n])).values()];
    const date = namedDate($('.header-meta-date').first().text());
    const room = $('.event-bar-item.location').first().text().trim();
    const cancelled = /afgelast|cancelled|geannuleerd|verplaatst/i.test($('.header-meta-status').text()+' '+heading);
    const event = events.find(e=>searchKey(e.name) === searchKey(heading) && eventDate(e.startDate,country) === date &&
      !/EventCancelled|EventPostponed/.test(e.eventStatus || '') && [e.location].flat().length === 1 &&
      searchKey([e.location].flat()[0]?.name) === searchKey(room));
    if (event && date && /^(Grote zaal|Kleine zaal)$/i.test(room) && !cancelled && lineup.some(n=>artistInTitle(n,artist))) {
      const rawImage = typeof event.image === 'string' ? event.image : Array.isArray(event.image) ? event.image[0] : event.image?.url;
      output.push({artist:heading,eventName:heading,lineup,supportingArtists:lineup.filter(n=>searchKey(n)!==searchKey(heading)),date,venue:name,city,country,sourceUrl:url,image:safeURL(rawImage),ticketUrl:safeURL([event.offers].flat().find(o=>o?.url)?.url)});
    }
  }
  return output;
}
export async function fetchHTML(url, domain, fetcher = fetch) {
  // Effenaar embeds several MB of application data even on event pages.
  // Bound the downloaded bytes while allowing its verified current size.
  const maxBytes = domain === 'effenaar.nl' ? 8000000 : 2500000;
  for (let attempt=0; attempt<2; attempt++) {
    try {
      const response = await fetcher(url, { signal:AbortSignal.timeout(15000), headers:{'User-Agent':'ListeningMirror/1.0 (personal concert search)'} });
      if (!officialURL(response.url,domain)) throw new Error('Unexpected redirect');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('Page too large');
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new Error('Page too large');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) { if (attempt) throw error; await new Promise(r => setTimeout(r,600)); }
  }
}
export async function searchOfficialVenue(venue, artist, fetcher = fetchHTML, deadline = Infinity) {
  const domain = venue[3], agendaURL = `https://${domain}${venue[4]}`, agenda = await fetcher(agendaURL,domain), $ = cheerio.load(agenda);
  const output = parseOfficialEvents(agenda,agendaURL,venue,artist), links = new Set();
  $('a[href]').each((_,n) => {
    const text = [$(n).text(),$(n).attr('title'),$(n).find('img').attr('alt')].filter(Boolean).join(' ');
    const url = officialURL($(n).attr('href'),domain,agendaURL);
    // Link text can include a date and ticket label; candidate links are broad,
    // but the individual event parser above must confirm the exact artist.
    if (url && url !== agendaURL && (` ${searchKey(text)} `).includes(` ${searchKey(artist)} `)) links.add(url);
  });
  let failures = 0, truncated = links.size > 12;
  for (const url of [...links].slice(0,12)) {
    if (Date.now() > deadline - 32000) { truncated = true; break; }
    try { output.push(...parseOfficialEvents(await fetcher(url,domain),url,venue,artist)); } catch { failures++; }
    await new Promise(r => setTimeout(r,250));
  }
  return { events:output, failures, truncated };
}
export async function searchConcerts(request, { dayCacheEntries, startDate, endDate, podiumFetcher, officialFetcher, internationalFetcher } = {}) {
  const { artist,place } = validateSearchRequest(request), warnings = [];
  const scope = searchLocation(place), nationwide = scope.country === 'NL' && !scope.place;
  const deadline = Date.now() + 420000;
  if (scope.country && scope.country !== 'NL') return searchInternationalConcerts({artist,scope,startDate,endDate,deadline,fetcher:internationalFetcher || fetchHTML});
  const inLocation = c => scope.country ? matchesLocation(c,scope) : placeMatches(c,place);
  const catalogue = await searchCachedArtist({ artist,startDate,endDate,dayCacheEntries,deadline, fetcher:podiumFetcher || (async url=>{await new Promise(r=>setTimeout(r,1200));return fetchHTML(url,'podiuminfo.nl');}) });
  const expectedDays = Math.round((Date.parse(endDate)-Date.parse(startDate))/86400000)+1;
  if (catalogue.coveredDays < expectedDays) warnings.push(`The catalogue covers ${catalogue.coveredDays} of ${expectedDays} days in this search range. These results may be incomplete.`);
  if (catalogue.failures || catalogue.truncated) warnings.push('Some matching catalogue events could not be checked. These results may be incomplete.');
  const raw = catalogue.events.map(e => ({ artist:e.matchedTracked[0], lineup:e.lineup, supportingArtists:e.lineup.filter(n=>!isTrackedName(n,new Set([normalizeArtistName(artist)]))), date:e.date, venue:e.venue, city:e.city, country:e.country || '??', image:e.image, ticketUrl:e.ticketUrl, source:'podiuminfo',sourceId:e.concertId, sourceUrl:e.url }));
  const venues = SEARCH_VENUES.filter(v => inLocation({venue:v[0],city:v[1],country:v[2]}));
  // Different venue domains can be checked in parallel. Podiuminfo requests
  // above remain sequential to respect its stricter rate limit.
  const results = new Array(venues.length); let cursor = 0;
  await Promise.all(Array.from({length:Math.min(nationwide ? 3 : 1,venues.length)},async()=>{
    while (cursor < venues.length) {
      const index = cursor++, venue = venues[index];
      if (Date.now() > deadline - 32000) { results[index] = {timeout:true}; continue; }
      try { results[index] = await searchOfficialVenue(venue,artist,officialFetcher,deadline); }
      catch { results[index] = {failed:true}; }
    }
  }));
  for (const [index,venue] of venues.entries()) {
    const found = results[index];
    if (found.timeout) { warnings.push('The search reached its time limit. These results may be incomplete.'); continue; }
    if (found.failed) { warnings.push(`The official programme for ${venue[0]} could not be checked.`); continue; }
    raw.push(...found.events.map(e=>({...e,source:'official',sourceId:`${e.sourceUrl}|${e.date}|${searchKey(e.eventName)}|${searchKey(e.venue)}`})));
    if (found.failures || found.truncated) warnings.push(`${venue[0]} could not be checked completely.`);
  }
  if (nationwide && raw.some(c=>!c.country || c.country === '??')) warnings.push('Some locations could not be confirmed as Dutch and were left out. These results may be incomplete.');
  const concerts = [];
  for (const c of raw.filter(c => c.date >= startDate && c.date <= endDate && inLocation(c))) {
    const previous = concerts.find(x=>sameSearchConcert(x,c));
    // Keep Podiuminfo's canonical id even when adding the venue's source URL.
    if (previous) { if (c.source === 'official') { previous.officialUrl=c.sourceUrl; previous.image ||= c.image; } continue; }
    const id = c.source === 'podiuminfo' ? `rec-podiuminfo-${c.sourceId}` : `rec-official-${createHash('sha256').update(c.sourceId).digest('hex').slice(0,16)}`;
    concerts.push({ ...c,id,time:null,isFestival:false,sourceApis:[c.source],match:{score:0,label:'Added by you',matchedBy:'manual',reason:'Found by your search',matchedArtists:(c.lineup || [c.artist]).filter(n=>artistInTitle(n,artist))} });
  }
  return { concerts:concerts.sort((a,b)=>a.date.localeCompare(b.date)), warnings:[...new Set(warnings)], coverage:{startDate,endDate,country:scope.country,catalogueDays:catalogue.coveredDays,officialVenues:venues.map(v=>v[0])} };
}
