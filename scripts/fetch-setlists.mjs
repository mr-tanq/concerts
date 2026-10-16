#!/usr/bin/env node
import {readFile,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
  resolveSetlist,shouldCheckSetlist,artistKey,targetIdentity
} from './lib/setlist-resolver.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const OUT=path.join(ROOT,'data/setlists.json');
const key=process.env.SETLISTFM_API_KEY;
if (!key) throw new Error('Missing SETLISTFM_API_KEY');
const limit=Number(process.env.MAX_LOOKUPS || 40);
if (!Number.isInteger(limit) || limit<1 || limit>120)
  throw new Error('MAX_LOOKUPS must be 1–120');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let lastCall=0;

async function get(url) {
  for (let attempt=0;attempt<3;attempt++) {
    await sleep(Math.max(0,650-(Date.now()-lastCall)));
    lastCall=Date.now();
    const response=await fetch(url,{
      headers:{
        'x-api-key':key,
        Accept:'application/json',
        'User-Agent':'ListeningMirror/2.0'
      },
      signal:AbortSignal.timeout(15000)
    });
    if (response.status===404) return null;
    if ((response.status===429 || response.status>=500) && attempt<2) {
      await sleep(response.status===429 ? 10000 : 1000*(attempt+1));
      continue;
    }
    if (!response.ok) throw new Error(`Setlist API HTTP ${response.status}`);
    return response.json();
  }
}

const archive=JSON.parse(
  await readFile(path.join(ROOT,'data/archive.json'),'utf8'));
if (!Array.isArray(archive.concerts)) throw new Error('Invalid archive');

let store={setlists:{}};
try { store=JSON.parse(await readFile(OUT,'utf8')); }
catch (error) { if (error.code!=='ENOENT') throw error; }
if (!store.setlists || typeof store.setlists!=='object'
  || Array.isArray(store.setlists)) throw new Error('Invalid setlist snapshot');

const now=Date.now(), stamp=new Date(now).toISOString(), today=stamp.slice(0,10);
const past=archive.concerts.filter(c=>c.date && c.date<=today)
  .sort((a,b)=>b.date.localeCompare(a.date));
const queue=[];

for (const c of past) {
  let entry=store.setlists[c.id];
  if (entry && !entry.artists)
    entry=store.setlists[c.id]={
      artists:entry.artist ? {[artistKey(entry.artist)]:entry} : {}
    };
  if (entry)
    entry.artists=Object.fromEntries(Object.values(entry.artists)
      .filter(Boolean).map(r=>[artistKey(r.artist),r]));

  const billed=c.lineup?.length
    ? c.lineup : [c.artist,...(c.supportingArtists || [])];
  const selected=Array.isArray(c.seenArtists) ? c.seenArtists : billed;
  const artists=[...new Map(selected
    .filter(name=>typeof name==='string' && artistKey(name))
    .map(name=>[artistKey(name),name])).values()];

  for (const artist of artists) {
    const previous=entry?.artists?.[artistKey(artist)];
    if (shouldCheckSetlist(previous,c,artist,now)) queue.push({c,artist});
  }
}

const lastAttempt=({c,artist})=>Date.parse(
  store.setlists[c.id]?.artists?.[artistKey(artist)]?.lastAttemptAt
  || '1970-01-01');
queue.sort((a,b)=>lastAttempt(a)-lastAttempt(b));

let errors=0;
for (const {c,artist} of queue.slice(0,limit)) {
  const entry=store.setlists[c.id] ||= {artists:{}};
  const previous=entry.artists[artistKey(artist)];
  try {
    const result=await resolveSetlist(c,artist,get,now);
    const compatible=!previous?.targetIdentity
      || previous.targetIdentity===targetIdentity(c,artist);
    const kept=compatible && previous?.sets?.length ? previous : null;
    entry.artists[artistKey(artist)]={
      ...(result || kept || {artist,sets:[]}),
      matchingVersion:4,targetIdentity:targetIdentity(c,artist),
      matchType:result?.matchType || kept?.matchType
        || (kept ? 'unverified' : 'missing'),
      checkedAt:(result || !kept) ? stamp : kept.checkedAt,
      lastExactCheckAt:stamp,lastAttemptAt:stamp,lastError:null
    };
    console.log(`${c.date} ${artist}: ${
      result?.matchType || (kept ? 'saved result retained' : 'no verified match')
    }`);
  } catch (error) {
    errors++;
    entry.artists[artistKey(artist)]={
      ...(previous || {artist,sets:[]}),
      lastAttemptAt:stamp,lastError:'Setlist check failed'
    };
    console.warn(`${c.date} ${artist}: check failed; previous result retained`);
  }
}

const results=Object.values(store.setlists)
  .flatMap(entry=>Object.values(entry.artists || {}));
const snapshot={
  $schema:'Listening Mirror Setlists v3',
  meta:{
    lastUpdated:stamp,checked:results.length,
    withSetlist:results.filter(r=>r.sets?.length).length,
    references:results.filter(r=>r.matchType==='tour-reference').length,
    remaining:Math.max(0,queue.length-limit),errors
  },
  setlists:store.setlists
};
await writeFile(OUT+'.tmp',JSON.stringify(snapshot,null,2)+'\n');
await rename(OUT+'.tmp',OUT);
console.log(`Checked ${Math.min(limit,queue.length)}; errors ${errors}; remaining ${snapshot.meta.remaining}.`);
