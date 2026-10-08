import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { searchConcerts } from './sources/manual-concert-search.mjs';
import { validateSearchRequest } from '../js/concert-search-model.js';
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
async function main() {
  const request = await readJSON('data/concert-search-request.json');
  if (!request.id) { console.log('No search requested.'); return; }
  validateSearchRequest(request);
  const now = new Date().toISOString(), startDate = localDate(Date.now(),'Europe/Amsterdam');
  const end = new Date(startDate+'T12:00:00Z'); end.setUTCFullYear(end.getUTCFullYear()+1);
  let result;
  try {
    const cache = await readJSON('data/podiuminfo-day-cache.json').catch(()=>({entries:{}}));
    const found = await searchConcerts(request,{dayCacheEntries:cache.entries || {},startDate,endDate:end.toISOString().slice(0,10)});
    result = {requestId:request.id,artist:request.artist,place:request.place,status:'complete',checkedAt:new Date().toISOString(),...found};
  } catch (error) {
    console.error('Search failed:',error.message);
    result = {requestId:request.id,status:'error',checkedAt:now,message:'The concert sources could not be checked. Please try again.'};
  }
  if (!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_TOKEN) throw new Error('Missing repository credentials');
  await publishSearchResult(process.env.GITHUB_REPOSITORY,process.env.GITHUB_TOKEN,result);
  console.log(`Search ${request.id}: ${result.concerts?.length || 0} verified result(s).`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});
