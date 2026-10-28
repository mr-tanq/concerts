import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {photoURL,photoCandidates,rasterExtension,cacheSharePhotos} from './cache-share-photos.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=','base64');

test('rejects unsafe sources and placeholder images',()=>{
  for(const u of [
    'http://venue.nl/a.jpg','file:///etc/passwd',
    'https://127.0.0.1/a','https://localhost/a',
    'https://user:pass@venue.nl/a','https://venue.nl/placeholder.jpg'
  ])assert.equal(photoURL(u),null);
  assert.equal(photoURL('https://venue.nl/a.jpg#x'),'https://venue.nl/a.jpg');
});

test('collects compound bills and relevant fallbacks without duplicates',()=>{
  const url='https://venue.nl/photo.jpg';
  const urls=photoCandidates({concerts:[
    {artist:'Moonspell + Guests',image:url,venue:'Room',date:'2027-04-18'},
    {artist:'Second band',venue:'Room',date:'2027-04-18'}
  ]},{artists:{}},{entries:{
    one:{image:url,lineup:['Moonspell + Guests']},
    two:{image:'https://venue.nl/room.jpg',venue:'Room',date:'2027-04-18'},
    three:{image:'https://venue.nl/unrelated.jpg',lineup:['Other']}
  }});
  assert.deepEqual(urls,[url,'https://venue.nl/room.jpg']);
});

test('accepts raster images and rejects HTML or SVG',()=>{
  assert.equal(rasterExtension(png),'png');
  for(const bytes of [Buffer.from('<html>Error</html>'),Buffer.from('<svg/>')])
    assert.throws(()=>rasterExtension(bytes));
});

test('reuses cached files, preserves concert data and removes unused generated files',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'share-photos-'));
  try {
    await mkdir(path.join(root,'data'));
    const planned=JSON.stringify({
      concerts:[{artist:'Band',image:'https://venue.nl/photo.png'}]
    });
    await writeFile(path.join(root,'data/planned.json'),planned);
    let calls=0;
    const load=async()=>{calls++;return png;};
    await cacheSharePhotos(root,load);
    const index=JSON.parse(await readFile(path.join(root,'data/share-photos.json')));
    const file=index.photos['https://venue.nl/photo.png'];
    assert.match(file,/^assets\/share-photos\/[a-f0-9]{64}\.png$/);
    assert.deepEqual(await readFile(path.join(root,file)),png);
    await cacheSharePhotos(root,load);
    assert.equal(calls,1);
    assert.equal(await readFile(path.join(root,'data/planned.json'),'utf8'),planned);
    await writeFile(path.join(root,'data/planned.json'),'{"concerts":[]}');
    await cacheSharePhotos(root,load);
    await assert.rejects(readFile(path.join(root,file)));
  }finally{await rm(root,{recursive:true,force:true});}
});
