import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {fetchFestivalPage,parseFestivalEvents,festivalURL} from './sources/festivalinfo.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function cacheFestivalImages(records,previous={editions:{}},{fetcher=fetchFestivalPage,now=Date.now(),pause=()=>new Promise(r=>setTimeout(r,1000))}={}) {
  const editions={...previous.editions},wanted=new Map();
  for(const c of records)if(c.isFestival){const url=festivalURL(c.sourceUrl);if(url)wanted.set(url,c);}
  for(const [url,c]of wanted) {
    const old=editions[url];
    if(old?.imageVersion===1 && now-old.checkedAt<20*3600000)continue;
    try {
      await pause();
      const event=parseFestivalEvents(await fetcher(url),url)[0];
      if(!event)throw Error('Festival edition not verified');
      editions[url]={image:event.image,imageVersion:1,checkedAt:now};
    }catch(error){console.warn(`Festival image left unchanged: ${url}: ${error.message}`);}
  }
  return {version:1,editions};
}
async function main() {
  const read=p=>readFile(path.join(ROOT,p),'utf8').then(JSON.parse);
  const records=await Promise.all(['data/recommendations.json','data/planned.json'].map(p=>read(p)));
  const previous=await read('data/festival-images.json').catch(()=>({editions:{}}));
  const result=await cacheFestivalImages(records.flatMap(x=>x.concerts||[]),previous);
  await writeFile(path.join(ROOT,'data/festival-images.json'),JSON.stringify(result,null,2)+'\n');
  console.log(`Festival images saved: ${Object.values(result.editions).filter(e=>e.image).length}`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1;});
