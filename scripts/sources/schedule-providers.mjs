import * as cheerio from 'cheerio';
import { countryCode } from '../../js/concert-countries.js';
import { matchName, normalize, parseSchedule, allowedURL } from './concert-schedule.mjs';

// Verified publisher relationships, not individual concert exceptions.
// An organizer page must also name the expected venue before it is accepted.
export const EXTRA_VENUES = [
  ['Theater aan het Vrijthof','theateraanhetvrijthof.nl','/voorstellingen'],
  ['Stadsschouwburg Utrecht','stadsschouwburg-utrecht.nl','/agenda'],
  ['Iduna','iduna.nl','/evenementen/'], ['Gashouder','gashouder.nl','/programma'],
  ['SPOT/De Oosterpoort','spotgroningen.nl','/programma/'],
  ['Johan Cruijff ArenA','johancruijffarena.nl','/kalender/'],
  ['De Doelen','dedoelen.nl','/nl/agenda'], ['Parallel','paradiso.nl','/programma'],
  ['My Name is PHIL','philhaarlem.nl','/nl/agenda'],
  ['Zik-Zak','zik-zak.be','/agenda/liste/'],
  ['De Pit','poppodiumdepit.nl','/'], ['De Bosuil','debosuil.nl','/programma/'],
  ['Koninklijk Theater Carre','carre.nl','/voorstellingen'],
  ['EKKO','ekko.nl','/programma/'], ['Little Devil','013.nl','/programma'],
  ['Neushoorn','neushoorn.nl','/'],
];
const ALIASES = {
  'my name in phil': 'my name is phil', phil: 'my name is phil',
  'koninklijk theater carre': 'koninklijk theater carre',
  'spot de oosterpoort': 'spot de oosterpoort', 'de oosterpoort': 'spot de oosterpoort',
  'ziggo dome': 'ziggo dome',
};
export const venueKey = name => ALIASES[normalize(name)] || normalize(name);
export function extraVenue(c) { return EXTRA_VENUES.find(v => venueKey(v[0]) === venueKey(c.venue)); }
export function publisherConfigs(c, primary) {
  const key = venueKey(c.venue), out = primary ? [primary] : [];
  if (['ziggo dome','afas live','johan cruijff arena','gashouder','koninklijk theater carre'].includes(key)) out.push([c.venue,'mojo.nl','/agenda']);
  if (key === 'my name is phil') out.push([c.venue,'patronaat.nl','/programma/']);
  if (key === 'de doelen') out.push([c.venue,'rotown.nl','/agenda/']);
  return out;
}
export function isOrganizer(c, host, primary) {
  return host !== primary?.[1] || ['parallel','little devil'].includes(venueKey(c.venue));
}
export function venueOnPage(html, c) {
  const $ = cheerio.load(html);
  $('nav,footer,aside,[class*="related"],[class*="recommend"]').remove();
  const text = ($('main').length ? $('main').text() : $('body').text()) + ' ' +
    $('script[type="application/ld+json"]').map((_,n) => $(n).text()).get().join(' ');
  const names = [c.venue];
  if (venueKey(c.venue) === 'my name is phil') names.push('PHIL');
  if (venueKey(c.venue) === 'koninklijk theater carre') names.push('Carre');
  if (venueKey(c.venue) === 'spot de oosterpoort') names.push('De Oosterpoort');
  const events=[];
  const collect=e=>{if(Array.isArray(e))return e.forEach(collect);if(!e||typeof e!=='object')return;if([e['@type']].flat().some(t=>/Event$/.test(t)))events.push(e);if(e['@graph'])collect(e['@graph']);};
  $('script[type="application/ld+json"]').each((_,n)=>{try{collect(JSON.parse($(n).text()))}catch{}});
  const matching=events.filter(e=>matchName(e.name,c.artist) && String(e.startDate).slice(0,10)===c.date && e.location?.name);
  if(matching.length) return matching.some(e=>names.some(n=>matchName(e.location.name,n)) && (!countryCode(c.country) || !e.location.address?.addressCountry || countryCode(e.location.address.addressCountry)===countryCode(c.country)));
  return names.some(n => matchName(text,n));
}

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function parseZiggo(payload, c, url, now) {
  const rows = payload?.data;
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const e = rows[0];
  if (!matchName(e.performerName,c.artist) || String(e.showDate).slice(0,10) !== c.date || venueKey(c.venue) !== 'ziggo dome') return null;
  const $ = cheerio.load(e.supportActDescription || '');
  const names = $('strong').map((_,n) => $(n).text().replace(/^(?:special guest|support)\s*[|:]\s*/i,'').trim()).get()
    .filter(n => n.length > 1 && n.length < 100);
  const programme = (payload.program || []).flatMap(x => Array.isArray(x.program) ? x.program : []);
  // showDate's time is a CMS sorting value; only public programme rows are times.
  const html = `<main><h1>${escape(e.performerName)}</h1><time datetime="${c.date}"></time>${names.map(n=>`<p>Support: ${escape(n)}</p>`).join('')}<div class="ziggo-programme">${programme.map(p=>`<div class="timeline-item"><span class="time">${escape(p.time)}</span><span class="title">${escape(p.title)}</span></div>`).join('')}</div></main>`;
  const result = parseSchedule(html,c,url,'official',now);
  if (result) {
    result.source.adapter = 'ziggo-public-programme';
    // “Aanvang show” does not identify which act takes the stage.
    if (result.values.start) result.values.start.unassigned = true;
  }
  return result;
}
export async function ziggoCandidates(c, fetcher) {
  const page = await fetcher(`https://www.ziggodome.nl/api/search/${encodeURIComponent(c.artist)}`,['ziggodome.nl']);
  const data = JSON.parse(page.html);
  return (data.resultsEvents || []).filter(e => matchName(e.performerName,c.artist) && String(e.showDate).slice(0,10) === c.date && /^[a-f0-9-]{36}$/i.test(e.id))
    .map(e => `https://www.ziggodome.nl/events/${e.id}/`);
}
export function ziggoAPI(url) {
  const u = new URL(url);
  if (u.hostname.replace(/^www\./,'') !== 'ziggodome.nl') return null;
  const id = u.pathname.match(/^\/(?:nl\/|en\/)?events\/([a-f0-9-]{36})\/?$/i)?.[1];
  return id ? `https://www.ziggodome.nl/api/agenda/events/${id}` : null;
}

export async function completeOfficialPage(page, c, now, fetcher) {
  const $ = cheerio.load(page.html), host = new URL(page.url).hostname.replace(/^www\./,'');
  // EKKO exposes event-specific public ACF fields through the REST link in HTML.
  if (host === 'ekko.nl') {
    const rest = allowedURL($('link[type="application/json"]').attr('href'),['ekko.nl']);
    if (rest && /^\/wp-json\/wp\/v2\/event\/\d+$/.test(new URL(rest).pathname)) {
      const response = await fetcher(rest,['ekko.nl']), data=JSON.parse(response.html), a=data.acf;
      const title=cheerio.load(data.title?.rendered || '').text();
      if (a && matchName(title,c.artist) && String(a.date_time).slice(0,10)===c.date && data.link?.replace(/\/$/,'')===page.url.replace(/\/$/,'')) {
        const support=String(a.support_act || '').split(/\s+\+\s+/).filter(Boolean);
        const html=`<main><h1>${escape(title)}</h1><time datetime="${c.date}"></time><p>Doors: ${escape(String(a.time_open || '').slice(0,5))}</p><p>Start: ${escape(String(a.date_time).slice(11,16))}</p>${support.map(n=>`<p>Support: ${escape(n)}</p>`).join('')}${a.show_end_time_on_event_page===true ? `<p>End: ${escape(String(a.date_time_end || '').slice(11,16))}</p>` : ''}</main>`;
        const result=parseSchedule(html,c,page.url,'official',now);
        if(result) {result.source.identityUrl=rest; result.source.adapter='wordpress-event-fields';return result;}
      }
    }
  }
  // Follow only an event-specific ticket link published by the official venue.
  // Select that exact event from the shop's ItemList; never parse the whole shop
  // as one concert, and never use ticket-sale end times as show end times.
  const links=[...new Set($('a[href]').map((_,n)=>$(n).attr('href')).get())].filter(raw=>{
    try {const u=new URL(raw);return u.protocol==='https:' && /^[a-z0-9-]+\.stager\.co$/.test(u.hostname) && !u.username && !u.password && /\/events\/\d+\/?$/.test(u.pathname);}catch{return false;}
  }).slice(0,2);
  for(const link of links) {
    const ticket=await fetcher(link,[new URL(link).hostname]), t=cheerio.load(ticket.html), events=[];
    const collect=value=>{if(Array.isArray(value))return value.forEach(collect);if(!value||typeof value!=='object')return;if(value['@type']==='Event')events.push(value);for(const key of ['@graph','itemListElement','item'])if(value[key])collect(value[key]);};
    t('script[type="application/ld+json"]').each((_,n)=>{try{collect(JSON.parse(t(n).text()))}catch{}});
    const event=events.find(e=>e.url?.replace(/\/$/,'')===link.replace(/\/$/,'') && matchName(e.name,c.artist) && String(e.startDate).slice(0,10)===c.date && matchName(e.location?.name,c.venue) && (!countryCode(c.country) || countryCode(e.location?.address?.addressCountry)===countryCode(c.country)));
    if(!event) continue;
    const identity={'@type':'MusicEvent',name:event.name,startDate:event.startDate,location:event.location,performer:event.performer};
    const result=parseSchedule(page.html+`<script type="application/ld+json">${JSON.stringify(identity).replace(/</g,'\\u003c')}</script>`,c,page.url,'official',now);
    if(result){result.source.identityUrl=link;result.source.adapter='venue-with-ticket-date';return result;}
  }
  return null;
}
