import {readFile,writeFile,mkdir,readdir,unlink,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export function photoURL(raw) {
  try {
    const u=new URL(raw);
    if(u.protocol!=='https:' || u.username || u.password || u.port
      || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)
      || /(^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname)
      || /e23066163f21176a822b54001ee648a2|placeholder/i.test(u.href))return null;
    u.hash='';return u.href;
  }catch{return null;}
}
const key=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();

export function photoCandidates(planned,artists,cache) {
  const urls=new Set(),byArtist=new Map(),byVenue=new Map();
  for(const v of Object.values(cache.entries||{})) {
    if(!v?.image)continue;
    const name=key(v.lineup?.[0]);
    if(name && !byArtist.has(name))byArtist.set(name,v.image);
    if(v.venue && v.date)byVenue.set(key(v.venue)+'|'+v.date,v.image);
  }
  for(const c of planned.concerts||[]) {
    let image=artists.artists?.[key(c.artist)]?.image || c.image || byArtist.get(key(c.artist));
    if(!image) {
      const id=c.sourceId || String(c.id||'').match(/podiuminfo-(\d+)/)?.[1]
        || String(c.recommendationId||'').match(/podiuminfo-(\d+)/)?.[1];
      image=cache.entries?.[id]?.image || byVenue.get(key(c.venue)+'|'+c.date);
    }
    const u=photoURL(image);
    // This verified CDN already permits canvas export through CORS.
    if(u && new URL(u).hostname!=='cdn-images.dzcdn.net')urls.add(u);
  }
  return [...urls];
}
export function rasterExtension(bytes) {
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'jpg';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP')return 'webp';
  if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))return 'gif';
  throw Error('Unsupported image format');
}
async function download(raw) {
  let url=photoURL(raw);
  for(let i=0;i<5 && url;i++) {
    const res=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
    if([301,302,303,307,308].includes(res.status)) {
      const next=photoURL(new URL(res.headers.get('location'),url).href);
      await res.body?.cancel();url=next;continue;
    }
    if(!res.ok)throw Error('HTTP '+res.status);
    const chunks=[];let size=0;
    for await(const chunk of res.body) {
      size+=chunk.length;
      if(size>12*1024*1024)throw Error('Photo too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw Error('Invalid image redirect');
}
export async function cacheSharePhotos(root,load=download) {
  const read=async file=>{
    try{return JSON.parse(await readFile(path.join(root,file),'utf8'));}
    catch{return {};}
  };
  const [planned,artists,cache,old]=await Promise.all([
    'data/planned.json','data/artist-images.json',
    'data/podiuminfo-cache.json','data/share-photos.json'
  ].map(read));
  if(!Array.isArray(planned.concerts))throw Error('Missing planned concerts');

  const folder=path.join(root,'assets/share-photos');
  await mkdir(folder,{recursive:true});
  const photos={};
  for(const url of photoCandidates(planned,artists,cache)) {
    const previous=old.photos?.[url];
    if(/^assets\/share-photos\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(previous||'')) {
      try {
        await access(path.join(root,previous));
        photos[url]=previous;continue;
      }catch{}
    }
    try {
      const bytes=await load(url),ext=rasterExtension(bytes);
      const name=createHash('sha256').update(url).digest('hex')+'.'+ext;
      await writeFile(path.join(folder,name),bytes);
      photos[url]='assets/share-photos/'+name;
    }catch(e){
      console.warn('Share photo unavailable:',new URL(url).hostname,e.message);
    }
  }
  await writeFile(path.join(root,'data/share-photos.json'),
    JSON.stringify({version:1,photos},null,2)+'\n');

  const keep=new Set(Object.values(photos).map(p=>path.basename(p)));
  for(const name of await readdir(folder)) {
    if(/^[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(name) && !keep.has(name))
      await unlink(path.join(folder,name));
  }
  console.log('Share photos cached:',Object.keys(photos).length);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  cacheSharePhotos(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'))
    .catch(e=>{console.error(e);process.exitCode=1;});
}
