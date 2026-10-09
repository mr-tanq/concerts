#!/usr/bin/env node
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as cheerio from "cheerio";
import { localDate, validDate, venueInstant } from "../js/concert-schedule.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export { parseSchedule, mergeSchedule, normalize } from "./sources/concert-schedule.mjs";
import { parseSchedule, mergeSchedule, normalize, matchName, venueConfig, zoneFor, allowedURL } from "./sources/concert-schedule.mjs";

export function checkPhase(concert, now = Date.now(), force = false) {
  if (!validDate(concert.date) || !zoneFor(concert)) return null;
  const today = localDate(now,zoneFor(concert)), s = concert.schedule?.date === concert.date ? concert.schedule : null;
  if (concert.date < today) return null;
  if (s?.lastAttemptAt && now - Date.parse(s.lastAttemptAt) < 50*60000) return null;
  if (force) return "manual";
  if (concert.date === today) {
    if (s?.end?.at && now >= Date.parse(s.end.at)) return null;
    return "sameDay"; // hourly on the day; clock rendering itself makes no requests.
  }
  // 20:00 is ONLY a check scheduling anchor when no published time exists; never a display time.
  const anchor = Date.parse(s?.doors?.at || s?.main?.at || venueInstant(concert.date,"20:00",zoneFor(concert)));
  const hours = (anchor-now)/3600000;
  if (hours <= 24) return s?.checks?.before24h ? null : "before24h";
  if (hours <= 48) return s?.checks?.before48h ? null : "before48h";
  if (s?.lastAttemptAt && now - Date.parse(s.lastAttemptAt) < 24*3600000) return null;
  return s?.lastCheckedAt ? null : "initial";
}

async function fetchPage(url, hosts) {
  let current = allowedURL(url,hosts); if (!current) throw new Error("Unapproved source host");
  for (let redirect=0;redirect<5;redirect++) {
    const res = await fetch(current,{redirect:"manual",signal:AbortSignal.timeout(15000),headers:{"User-Agent":"ListeningMirrorSchedule/1.0 (+https://github.com/mr-tanq/concerts)",Accept:"text/html"}});
    if ([301,302,303,307,308].includes(res.status)) { current=allowedURL(new URL(res.headers.get("location"),current).href,hosts);if(!current) throw new Error("Redirect outside venue");continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text(); if (html.length>5_000_000) throw new Error("Page too large");
    return {html,url:current};
  }
  throw new Error("Too many redirects");
}

export async function enrichOne(concert, now, phase, fetcher = fetchPage) {
  const config = venueConfig(concert), host = config?.[1];
  const official = host ? [host] : [];
  const secondary = ["podiuminfo.nl"];
  const results=[], candidates=new Set(), visited=new Set();
  const add = url => { const u=allowedURL(url,official); if(u) candidates.add(u); };
  for (const url of [concert.officialEventUrl,...(concert.scheduleSourceUrls || []), ...(concert.schedule?.sources || []).filter(s=>s.kind==="official").map(s=>s.url)]) add(url);
  if (allowedURL(concert.sourceUrl,official)) add(concert.sourceUrl);
  const sourceId = concert.source === "podiuminfo" && /^\d+$/.test(String(concert.sourceId || "")) ? concert.sourceId : String(concert.id || "").match(/podiuminfo-(\d+)/)?.[1];
  const podium = allowedURL(concert.sourceUrl,secondary) || (sourceId ? `https://www.podiuminfo.nl/concert/${sourceId}/` : null);
  if (podium) try {
    const page=await fetcher(podium,secondary), parsed=parseSchedule(page.html,concert,page.url,"secondary",now);
    if(parsed) {
      results.push(parsed);
      const $=cheerio.load(page.html);$("a[href]").each((_,n)=>{try{add(new URL($(n).attr("href"),page.url).href);}catch{}});
    }
  } catch(e) { console.warn(`${concert.id}: secondary ${e.message}`); }
  const parseOfficial = async url => {
    if(visited.has(url)) return false;visited.add(url);
    try { const page=await fetcher(url,official), parsed=parseSchedule(page.html,concert,page.url,"official",now);if(parsed){results.push(parsed);return true;} } catch(e){console.warn(`${concert.id}: venue ${e.message}`);} return false;
  };
  for(const url of candidates) if(visited.size<8) await parseOfficial(url);
  if(host && !results.some(r=>r.source.kind==="official")) {
    // Discover links from the venue's own agenda and sitemap. Every candidate must pass artist + date validation.
    for(const listing of [`https://${host}${config[2]}`,`https://${host}/sitemap.xml`]) {
      try {
        const page=await fetcher(listing,official), $=cheerio.load(page.html);
        const links=[];
        $("a[href],loc").each((_,n)=>{const raw=$(n).attr("href") || $(n).text();try{const url=new URL(raw,page.url).href;if(allowedURL(url,official) && matchName($(n).text()+" "+decodeURIComponent(url),concert.artist)) links.push(url);}catch{}});
        for(const url of [...new Set(links)].slice(0,8)) if(await parseOfficial(url)) break;
      } catch(e) { console.warn(`${concert.id}: discovery ${e.message}`); }
      if(results.some(r=>r.source.kind==="official")) break;
    }
  }
  return mergeSchedule(concert,results,now,phase);
}

export function applyUpdates(data, updates) {
  let changed=false;
  for(const update of updates) {
    const c=data.concerts.find(c=>c.id===update.id && c.date===update.date && normalize(c.artist)===normalize(update.artist) && normalize(c.venue)===normalize(update.venue));
    if(!c || Date.parse(c.schedule?.lastAttemptAt || 0)>Date.parse(update.schedule.lastAttemptAt)) continue;
    if(JSON.stringify(c.schedule)!==JSON.stringify(update.schedule)){c.schedule=update.schedule;changed=true;}
  }
  if(changed){data.meta ||= {};data.meta.lastUpdated=new Date().toISOString();}
  return changed;
}

export async function publishUpdates(updates, request, branch="main") {
  for(let attempt=0;attempt<4;attempt++) {
    const file=await request(`contents/data/planned.json?ref=${encodeURIComponent(branch)}`);
    const data=JSON.parse(Buffer.from(file.content,"base64").toString("utf8"));
    if(!Array.isArray(data.concerts)) throw new Error("Invalid planned snapshot");
    if(!applyUpdates(data,updates)) return false;
    try {
      await request("contents/data/planned.json",{method:"PUT",body:JSON.stringify({message:"chore: refresh concert schedules",branch,sha:file.sha,content:Buffer.from(JSON.stringify(data,null,2)+"\n").toString("base64")})});return true;
    } catch(e) { if(![409,422].includes(e.status) || attempt===3) throw e; }
  }
}

async function main() {
  const file=path.join(ROOT,"data/planned.json"), data=JSON.parse(await readFile(file,"utf8"));
  if(!Array.isArray(data.concerts)) throw new Error("Invalid planned.json");
  const now=Date.now(), stamp=new Date(now).toISOString(), today=localDate(now);
  const future=data.concerts.filter(c=>validDate(c.date) && c.date>=today).sort((a,b)=>a.date.localeCompare(b.date));
  const updates=[];
  for(const c of future) {
    // Enrich NEXT immediately; others enter the queue one week before their date.
    if(c!==future[0] && Date.parse(`${c.date}T12:00Z`)-now>7*86400000) continue;
    const phase=checkPhase(c,now,process.argv.includes("--force"));if(!phase) continue;
    const schedule=await enrichOne(c,stamp,phase);updates.push({id:c.id,date:c.date,artist:c.artist,venue:c.venue,schedule});
    console.log(`${c.artist} ${c.date}: ${phase}, ${schedule.lastError || `${schedule.sources.length} sources`}`);
  }
  if(process.argv.includes("--publish")) {
    const token=process.env.GITHUB_TOKEN, repo=process.env.GITHUB_REPOSITORY;
    if(!token || !/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new Error("Missing repository/token");
    const request=async(endpoint,options={})=>{
      const res=await fetch(`https://api.github.com/repos/${repo}/${endpoint}`,{...options,signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json","Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28"}});
      if(!res.ok){const e=new Error(`GitHub HTTP ${res.status}`);e.status=res.status;throw e;}return res.json();
    };
    const changed=updates.length ? await publishUpdates(updates,request,process.env.GITHUB_REF_NAME || "main") : false;
    if(process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,`changed=${changed}\n`);
  } else if(applyUpdates(data,updates)) await writeFile(file,JSON.stringify(data,null,2)+"\n");
  for (const update of updates.filter(u => u.schedule.lastError)) {
    console.warn(`${update.artist}: schedule unavailable; keeping TBA/previous confirmed times for the next check.`);
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1;});
