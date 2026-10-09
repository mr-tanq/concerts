import * as cheerio from "cheerio";
import { countryCode, countryZone } from "../../js/concert-countries.js";
import { localDate, validDate, venueInstant } from "../../js/concert-schedule.js";

export const normalize = s => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Only venue-owned hosts may outrank secondary listings. Unknown venues stay TBA.
const VENUES = [
  ["Hall Of Fame", "hall-fame.nl", "/programma"], ["Paard", "paard.nl", "/agenda/"],
  ["TivoliVredenburg", "tivolivredenburg.nl", "/agenda/"], ["013", "013.nl", "/programma"],
  ["Paradiso", "paradiso.nl", "/nl/programma"], ["Melkweg", "melkweg.nl", "/nl/agenda/"],
  ["Ziggo Dome", "ziggodome.nl", "/agenda"], ["Patronaat", "patronaat.nl", "/programma/"],
  ["Doornroosje", "doornroosje.nl", "/programma/"], ["AFAS Live", "afaslive.nl", "/agenda"],
  ["dB's", "dbstudio.nl", "/programma/"], ["Vera", "vera-groningen.nl", "/events/"],
  ["Effenaar", "effenaar.nl", "/agenda"], ["Muziekgieterij", "muziekgieterij.nl", "/agenda/"],
  ["Baroeg", "baroeg.nl", "/agenda/"], ["Annabel", "annabel.nu", "/agenda/"],
  ["Botanique", "botanique.be", "/en/concerts"], ["Bibelot", "bibelot.net", "/agenda/"],
  ["Grenswerk", "grenswerk.nl", "/agenda/"], ["Willemeen", "willemeen.nl", "/agenda/"],
];
const MONTHS = ["januari|january", "februari|february", "maart|march", "april", "mei|may", "juni|june", "juli|july", "augustus|august", "september", "oktober|october", "november", "december"];
const timePattern = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g;
const times = text => [...String(text).matchAll(timePattern)].map(m => `${m[1].padStart(2,"0")}:${m[2]}`);
export const matchName = (text, name) => (` ${normalize(text)} `).includes(` ${normalize(name)} `);
export function venueConfig(c) {
  const code = countryCode(c.country);
  return VENUES.find(([name, host]) => normalize(name) === normalize(c.venue) && (!code || code === (host === "botanique.be" ? "BE" : "NL")));
}
export function zoneFor(c) { return countryCode(c.country) ? countryZone(c.country) : "Europe/Amsterdam"; }
function wallTime(value, c) {
  if (!zoneFor(c)) return null;
  const v = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    if (/(Z|[+-]\d{2}:\d{2})$/i.test(v)) {
      const parsed = Date.parse(v); if (!Number.isFinite(parsed)) return null;
      return {date:localDate(parsed,zoneFor(c)),time:new Intl.DateTimeFormat("en-GB",{timeZone:zoneFor(c),hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(parsed)};
    }
    return {date:v.slice(0,10),time:v.slice(11,16)};
  }
  return null;
}
export function allowedURL(value, hosts) {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && hosts.some(h => u.hostname === h || u.hostname === `www.${h}`) ? u.href : null; } catch { return null; }
}

function dateMatches(text, date) {
  if (!validDate(date)) return false;
  if (String(text).includes(date)) return true;
  const [y,m,d] = date.split("-").map(Number);
  const t = normalize(text);
  return new RegExp(`\\b0?${d} (${MONTHS[m-1]}) ${y}\\b`).test(t) || new RegExp(`\\b(${MONTHS[m-1]}) 0?${d} ${y}\\b`).test(t);
}

export function parseSchedule(html, concert, url, kind = "official", checkedAt = new Date().toISOString()) {
  const $ = cheerio.load(html);
  const events = [];
  function collect(value) {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== "object") return;
    if ([value["@type"]].flat().some(t => /^(MusicEvent|Event)$/.test(t))) events.push(value);
    if (value["@graph"]) collect(value["@graph"]);
  }
  $('script[type="application/ld+json"]').each((_, n) => { try { collect(JSON.parse($(n).text())); } catch {} });
  const matching = events.filter(e => matchName(e.name, concert.artist) && wallTime(e.startDate,concert)?.date === concert.date);
  $("script,style,nav,footer,body > header,aside,[class*='related'],[class*='recommend']").remove();
  const root = $("main").first().length ? $("main").first() : $("body");
  const heading = root.find("h1").first().text() || $("title").text();
  const text = root.text().replace(/\s+/g, " ");
  // Hall of Fame puts the full year in its single-event payload rather than the visible date.
  const dates = root.find("[datetime]").map((_, n) => $(n).attr("datetime")).get().join(" ");
  const hallDate = new URL(url).hostname.replace(/^www\./, "") === "hall-fame.nl" && /\/programma\/[^/?]+-\d+/.test(new URL(url).pathname) && html.includes(`"${concert.date}T`);
  if (!matching.length && !(matchName(heading, concert.artist) && (dateMatches(text + " " + dates, concert.date) || hallDate))) return null;
  const source = { url, kind, label: new URL(url).hostname.replace(/^www\./,""), checkedAt };
  const values = new Map(), conflicts = new Set();
  const supportNames = [...new Set((concert.supportingArtists || []).filter(Boolean))];
  root.find("h2,h3,h4,p").each((_, n) => {
    const s = $(n).text().trim(), m = s.match(/(?:special guest|support(?: act)?|voorprogramma)\s*:\s*([\p{L}\p{N} '&+.-]{2,70})$/iu);
    if (m && !matchName(m[1], concert.artist) && !times(m[1]).length) supportNames.push(m[1].trim());
  });
  const set = (key, name, time, evidence, endTime = null) => {
    if (conflicts.has(key)) return;
    const prior = values.get(key);
    if (prior && prior.time !== time) { values.delete(key); conflicts.add(key); return; }
    values.set(key, { name, time, dayOffset: 0, status: /verwacht|expected|ongeveer|estimated/i.test(evidence) ? "expected" : "confirmed", sourceUrl: url, sourceKind: kind, checkedAt, evidence: evidence.trim().slice(0,180) });
    if (key === "main" && endTime) set("end", "END", endTime, evidence);
  };
  const consume = (label, clock, evidence, namedTimetable = false) => {
    const ts = times(clock); if (!ts.length) return;
    const n = normalize(label);
    if (/^(doors?( open)?|deuren?( open)?|zaal open|opening doors)$/.test(n)) set("doors", "DOORS", ts[0], evidence);
    else if (/^(end|einde|eindtijd|expected end|verwachte eindtijd|show ends?)$/.test(n)) set("end", "END", ts[0], evidence);
    else if (normalize(label) === normalize(concert.artist) || /^(main act|headliner|hoofdprogramma)$/.test(n)) set("main", concert.artist, ts[0], evidence, ts[1]);
    else {
      const known = supportNames.find(name => normalize(label) === normalize(name));
      if (known || /^(support( act)?|voorprogramma)$/.test(n)) set(`support:${normalize(known || label)}`, known || supportNames[0] || "SUPPORT", ts[0], evidence);
      // A named act in an explicit timetable is a support even when discovery omitted it.
      else if (namedTimetable && /^[\p{L}\p{N} '&+.-]{2,70}$/u.test(label.trim()) && !/start|aanvang|time|tijd|date|datum|price|prijs|tickets|bar|curfew|dj|afterparty/i.test(label)) set(`support:${normalize(label)}`, label.trim(), ts[0], evidence);
    }
  };
  root.find(".timeline-item").each((_, n) => consume($(n).find(".title").text().trim(), $(n).find(".time").text(), $(n).text(), true));
  root.find("tr").each((_, n) => {
    const cells = $(n).find("td,th").map((_, c) => $(c).text().trim()).get();
    if (cells.length === 2 && cells.filter(c => times(c).length).length === 1) consume(cells.find(c => !times(c).length), cells.find(c => times(c).length), cells.join(" "));
  });
  root.find("dt").each((_, n) => {
    const dd = $(n).next("dd");
    if (dd.length) consume($(n).text().trim(), dd.text(), `${$(n).text()} ${dd.text()}`);
  });
  // Explicit labelled fields only. Generic "Start", "Time" and JSON-LD startDate are NOT main-act times.
  root.find("p,li,dt,dd,div").each((_, n) => {
    const lines = $(n).html()?.replace(/<br\s*\/?\s*>/gi,"\n"); if (!lines) return;
    for (const line of cheerio.load(lines).text().split("\n")) {
      const clean = line.replace(/\s+/g," ").trim();
      if (clean.length > 150) continue;
      const m = clean.match(/^(doors?(?: open)?|deuren?(?: open)?|zaal open|end|einde|eindtijd|expected end|verwachte eindtijd|main act|headliner|hoofdprogramma|support(?: act)?|voorprogramma)\s*[:–-]?\s*((?:[01]?\d|2[0-3])[:.][0-5]\d(?:\s*(?:uur|h))?)$/i);
      if (m) consume(m[1],m[2],clean);
      // Artist-labelled line: name : 21:30, or 21:30 - Hällas. Whole-line match avoids prose dates.
      for (const name of [concert.artist, ...supportNames]) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
        const pair = clean.match(new RegExp(`^(${escaped})\\s*[:–-]?\\s*((?:[01]?\\d|2[0-3])[:.][0-5]\\d(?:\\s*[-–]\\s*(?:[01]?\\d|2[0-3])[:.][0-5]\\d)?)$`,"i")) || clean.match(new RegExp(`^((?:[01]?\\d|2[0-3])[:.][0-5]\\d)\\s*[-–:]?\\s*(${escaped})$`,"i"));
        if (pair) consume(name, clean, clean);
      }
    }
  });
  for (const e of matching) {
    if (e.doorTime) {
      const v = String(e.doorTime), wall = wallTime(v,concert);
      const t = wall?.date === concert.date ? wall.time : (/^\d{2}:\d{2}$/.test(v) ? v : null);
      if (t) set("doors","DOORS",t,`doorTime: ${v}`);
    }
    if (e.endDate && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.endDate)) {
      const next = new Date(`${concert.date}T12:00Z`); next.setUTCDate(next.getUTCDate()+1);
      const wall = wallTime(e.endDate,concert);
      if (wall && [concert.date,next.toISOString().slice(0,10)].includes(wall.date)) {
        set("end","END",wall.time,`endDate: ${e.endDate}`);
        if (values.has("end")) values.get("end").dayOffset = wall.date === concert.date ? 0 : 1;
      }
    }
  }
  // Explicit timetable ranges crossing midnight imply the end is the following day.
  if (values.get("end") && values.get("main") && values.get("end").time < values.get("main").time) values.get("end").dayOffset = 1;
  return { source, values: Object.fromEntries(values), supportNames: [...new Set(supportNames)], conflicts: [...conflicts] };
}

export function mergeSchedule(concert, results, now, phase) {
  const old = concert.schedule?.date === concert.date ? concert.schedule : {};
  const byURL = new Map(results.map(r => [r.source.url, r]));
  // Successful sources replace their own old fields, including removed/unconfirmed times.
  // A failed fetch retains its last evidence. A secondary source cannot replace official evidence.
  const fields = [old.doors, old.main, old.end, ...(old.support || [])].filter(f => f?.time && f.sourceUrl && !byURL.has(f.sourceUrl));
  const candidates = fields.map(f => ({ key: f === old.doors ? "doors" : f === old.main ? "main" : f === old.end ? "end" : `support:${normalize(f.name)}`, f }));
  for (const r of results) for (const [key,f] of Object.entries(r.values)) candidates.push({key,f});
  const selected = new Map(), disputed = new Map();
  for (const {key,f} of candidates) {
    const prior = selected.get(key);
    const rank = x => x.sourceKind === "official" ? 2 : 1;
    if (disputed.get(key) >= rank(f)) continue;
    if (prior && rank(f) === rank(prior) && f.checkedAt === prior.checkedAt && (f.time !== prior.time || f.dayOffset !== prior.dayOffset)) {
      selected.delete(key); disputed.set(key,rank(f)); continue;
    }
    if (!prior || rank(f) > rank(prior) || (rank(f) === rank(prior) && f.checkedAt >= prior.checkedAt)) selected.set(key,f);
  }
  // If an official page was successfully checked but now has no time, do not fall back to weaker old listings.
  if (results.some(r => r.source.kind === "official")) for (const [key,f] of selected) if (f.sourceKind !== "official") selected.delete(key);
  const zone = zoneFor(concert);
  const make = (key, name) => {
    const f = selected.get(key); if (!f || !zone) return { name, time: null };
    const at = venueInstant(concert.date, f.time, zone, f.dayOffset || 0);
    return at ? {...f, at} : {name, time:null};
  };
  const names = [...new Set([...(concert.supportingArtists || []), ...(old.support || []).map(f=>f.name), ...results.flatMap(r=>r.supportNames), ...[...selected].filter(([k])=>k.startsWith("support:")).map(([,f])=>f.name)])];
  const sources = new Map((old.sources || []).map(s=>[s.url,s]));
  for (const r of results) sources.set(r.source.url,r.source);
  const success = results.length > 0;
  const s = {version:1,date:concert.date,timeZone:zone,doors:make("doors","DOORS"),support:names.map(name=>make(`support:${normalize(name)}`,name)),main:make("main",concert.artist),end:make("end","END"),sources:[...sources.values()],lastCheckedAt:success ? now : old.lastCheckedAt || null,lastAttemptAt:now,checks:{...(old.checks || {}),...(success ? {[phase]:now} : {})},lastError:success ? null : "No matching source could be checked"};
  // Reject out-of-order schedules rather than guessing which field is wrong.
  const order = [s.doors,...s.support.sort((a,b)=>String(a.at||"z").localeCompare(String(b.at||"z"))),s.main,s.end].filter(f=>f.at);
  if (order.some((f,i)=>i && f.at < order[i-1].at)) for (const f of order) { f.time=null; delete f.at; }
  return s;
}
