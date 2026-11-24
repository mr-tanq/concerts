import { searchIncludingFestivals } from './sources/manual-festival-search.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateSearchRequest } from '../js/concert-search-model.js';
import { concertSearchEnd } from '../js/concert-search-window.js';
import { localDate } from '../js/concert-schedule.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const readJSON = p => readFile(path.join(ROOT,p),'utf8').then(JSON.parse);
export async function publishSearchResult(repository, token, result, fetcher = fetch) {
  const endpoint = `https://api.github.com/repos/${repository}/contents/data/concert-search-results/${result.requestId}.json`;
  const headers = { Authorization:`Bearer ${token}`, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28' };
  for (let attempt=0; attempt<4; attempt++) {
    const current = await fetcher(endpoint,{headers});
    if (!current.ok && current.status !== 404) throw new Error(`Result read failed: HTTP ${current.status}`);
    const sha = current.ok ? (await current.json()).sha : undefined;
    const response = await fetcher(endpoint,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({message:`chore: concert search result ${result.requestId}`,content:Buffer.from(JSON.stringify(result,null,2)+'\n').toString('base64'),...(sha ? {sha} : {})})});
    if (response.ok) return;
    if (![409,422].includes(response.status) || attempt===3) throw new Error(`Result save failed: HTTP ${response.status}`);
  }
}
// Search results are only read by the app for the few minutes after a
// search, so anything older than RESULT_KEEP_DAYS is removed after each new
// search instead of piling up in data/concert-search-results/ forever.
export const RESULT_KEEP_DAYS = 7;
export function staleResultFiles(results, now = Date.now(), keepDays = RESULT_KEEP_DAYS) {
  const cutoff = now - keepDays * 86400000;
  return results
    .filter(({ checkedAt }) => { const t = Date.parse(checkedAt); return !Number.isFinite(t) || t < cutoff; })
    .map(({ name }) => name);
}
export async function pruneOldResults(repository, token, { keep, now = Date.now(), fetcher = fetch, dir = path.join(ROOT, 'data/concert-search-results') } = {}) {
  const names = (await readdir(dir).catch(() => [])).filter(n => n.endsWith('.json') && n !== `${keep}.json`);
  const results = [];
  for (const name of names) {
    const checkedAt = await readFile(path.join(dir, name), 'utf8').then(t => JSON.parse(t).checkedAt).catch(() => null);
    results.push({ name, checkedAt });
  }
  const stale = staleResultFiles(results, now);
  if (!stale.length) return [];
  const base = `https://api.github.com/repos/${repository}/contents/data/concert-search-results`;
  const headers = { Authorization:`Bearer ${token}`, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28' };
  const listing = await fetcher(base, { headers });
  if (!listing.ok) throw new Error(`Result listing failed: HTTP ${listing.status}`);
  const shaByName = new Map((await listing.json()).map(f => [f.name, f.sha]));
  const removed = [];
  for (const name of stale) {
    const sha = shaByName.get(name);
    if (!sha) continue;
    const res = await fetcher(`${base}/${name}`, { method:'DELETE', headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify({ message:`chore: prune old concert search result ${name.replace(/\.json$/, '')}`, sha }) });
    if (res.ok) removed.push(name);
    else console.warn(`Could not prune ${name}: HTTP ${res.status}`);
  }
  return removed;
}

async function main() {
  const request = await readJSON('data/concert-search-request.json');
  if (!request.id) { console.log('No search requested.'); return; }
  validateSearchRequest(request);
  const now = new Date().toISOString(), startDate = localDate(Date.now(),'Europe/Amsterdam');
  const config = await readJSON('data/config.json');
  const endDate = concertSearchEnd(startDate, config.discovery);
  let result;
  try {
    const cache = await readJSON('data/podiuminfo-day-cache.json').catch(()=>({entries:{}}));
    const festivalCache=await readJSON('data/festivalinfo-cache.json').catch(()=>({months:{},editions:{}}));
    const identity=String(request.artist || '').trim()?{}:await readJSON('data/identity.json');
    const found=await searchIncludingFestivals(request,{dayCacheEntries:cache.entries || {},festivalCache,identity,startDate,endDate});
    result = {requestId:request.id,artist:request.artist,place:request.place,status:'complete',checkedAt:new Date().toISOString(),...found};
  } catch (error) {
    console.error('Search failed:',error.message);
    result = {requestId:request.id,status:'error',checkedAt:now,message:'The concert sources could not be checked. Please try again.'};
  }
  if (!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_TOKEN) throw new Error('Missing repository credentials');
  await publishSearchResult(process.env.GITHUB_REPOSITORY,process.env.GITHUB_TOKEN,result);
  console.log(`Search ${request.id}: ${result.concerts?.length || 0} verified result(s).`);
  try {
    const removed = await pruneOldResults(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN, { keep: request.id });
    if (removed.length) console.log(`Pruned ${removed.length} search result(s) older than ${RESULT_KEEP_DAYS} days.`);
  } catch (error) {
    // Housekeeping only: a failed prune must never fail the search itself.
    console.warn('Pruning old search results failed:', error.message);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});
