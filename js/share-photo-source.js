let cachedPhotos;
export async function sharePhotoSources(raw) {
  let original;
  try{original=new URL(raw,location.href);}catch{return [];}
  if(!['https:','http:'].includes(original.protocol))return [];
  original.hash='';
  const url=original.href;
  if(original.origin===location.origin)return [url];
  try {
    cachedPhotos ||= fetch(new URL('../data/share-photos.json',import.meta.url),{
      cache:'no-store',signal:AbortSignal.timeout(5000)
    }).then(r=>{
      if(!r.ok)throw Error('Photo index unavailable');
      return r.json();
    }).catch(e=>{cachedPhotos=null;throw e;});
    const local=(await cachedPhotos).photos?.[url];
    if(/^assets\/share-photos\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(local||'')) {
      return [new URL('../'+local,import.meta.url).href,url];
    }
  }catch{}
  return [url];
}
