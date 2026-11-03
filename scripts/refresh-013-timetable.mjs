// Refresh verified 013 event pages for today's Going shows after a parser update.
import {readFile,writeFile} from 'node:fs/promises';
import {localDate} from '../js/concert-schedule.js';
import {parseSchedule,mergeSchedule,venueConfig,allowedURL} from './sources/concert-schedule.mjs';
import {fetchPage,applyUpdates} from './enrich-concert-schedules.mjs';
const file=new URL('../data/planned.json',import.meta.url);
const snapshot=JSON.parse(await readFile(file,'utf8')),updates=[];
for(const concert of snapshot.concerts.filter(c=>c.date===localDate()&&venueConfig(c)?.[1]==='013.nl')) {
  const urls=[concert.officialEventUrl,concert.officialUrl,concert.sourceUrl,...(concert.schedule?.sources||[]).filter(s=>s.kind==='official').map(s=>s.url)];
  let result=null;
  for(const url of [...new Set(urls.map(u=>allowedURL(u,['013.nl'])).filter(Boolean))]) {
    try {
      const page=await fetchPage(url,['013.nl']),stamp=new Date().toISOString();
      const parsed=parseSchedule(page.html,concert,page.url,'official',stamp);
      if(!parsed)continue;
      const schedule=mergeSchedule(concert,[parsed],stamp,'manual');
      schedule.availability=Object.keys(parsed.values).length?'published':'not-published';
      schedule.discovery={version:2,configured:['013.nl'],requests:1,attempts:[{url:page.url,status:'fetched'},{url:page.url,status:Object.keys(parsed.values).length?'verified':'verified-no-times'}]};
      result={id:concert.id,date:concert.date,artist:concert.artist,venue:concert.venue,schedule};break;
    }catch(error){console.warn(`${concert.artist}: ${error.message}`);}
  }
  if(!result)throw Error(`No verified 013 page could be read for ${concert.artist}; previous data was kept.`);
  updates.push(result);
  console.log(`${concert.artist}: doors ${result.schedule.doors.time||'TBA'}, main ${result.schedule.main.time||'TBA'}, end ${result.schedule.end.time||'TBA'}`);
}
// Re-read before merging; update schedule fields only, using the existing identity guard.
const latest=JSON.parse(await readFile(file,'utf8'));
if(updates.length&&applyUpdates(latest,updates))await writeFile(file,JSON.stringify(latest,null,2)+'\n');
if(!updates.length)console.log('No 013 shows today. The corrected parser will run on the normal refresh schedule.');
