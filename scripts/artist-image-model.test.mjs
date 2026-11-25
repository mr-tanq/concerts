import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,mkdir,readFile,rm,stat,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {collectArtistImageNames,shouldPersistArtistImages,usableArtistPhoto} from './lib/artist-image-model.mjs';

test('collects headliner, lineup, separate supports and timetable-only supports together',()=>{
  const c={artist:'Placebo',date:'2026-10-27',lineup:['Placebo'],supportingArtists:['Guest Band'],
    schedule:{date:'2026-10-27',support:[{name:'The Mirror Trap'}]}};
  const names=collectArtistImageNames([[c],[{artist:'placebo',lineup:['Other Band']}]]);
  assert.deepEqual([...names.keys()],['placebo','guest band','the mirror trap','other band']);
});

test('ignores stale timetables, no-support metadata, placeholders and invalid names',()=>{
  const names=collectArtistImageNames([[{artist:'Band',date:'2026-10-27',
    supportingArtists:[null,'TBA'],schedule:{date:'2026-10-28',support:[{name:'Old Support'}]}},
    {artist:'Band',date:'2026-10-27',schedule:{date:'2026-10-27',noSupport:true,support:[{name:'Removed Support'}]}}]]);
  assert.deepEqual([...names.keys()],['band']);
});

test('placeholder artwork is not accepted as an artist photo',()=>{
  assert.equal(usableArtistPhoto('https://cdn-images.dzcdn.net/images/artist/e23066163f21176a822b54001ee648a2/1000.jpg'),null);
  assert.equal(usableArtistPhoto('javascript:alert(1)'),null);
  assert.equal(usableArtistPhoto('https://images.example.com/artist.jpg'),'https://images.example.com/artist.jpg');
});

test('only persists artist images when a lookup updated the store',()=>{
  assert.equal(shouldPersistArtistImages(0,0),false);
  assert.equal(shouldPersistArtistImages(1,0),true);
  assert.equal(shouldPersistArtistImages(0,1),true);
});

test('failed image lookup leaves the JSON and its lastUpdated unchanged',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'artist-images-'));
  try {
    await mkdir(path.join(root,'scripts/lib'),{recursive:true});
    await mkdir(path.join(root,'data'));
    for (const file of ['enrich-artist-images.mjs','lib/artist-image-model.mjs']) {
      await copyFile(new URL(file,import.meta.url),path.join(root,'scripts',file));
    }
    await writeFile(path.join(root,'data/archive.json'),JSON.stringify({concerts:[{artist:'Example Band'}]}));
    const target=path.join(root,'data/artist-images.json');
    const before=JSON.stringify({meta:{lastUpdated:'2020-01-02T03:04:05.000Z'},artists:{}})+'\n';
    await writeFile(target,before);
    await utimes(target,new Date('2020-01-01T00:00:00Z'),new Date('2020-01-01T00:00:00Z'));
    const modifiedBefore=(await stat(target)).mtimeMs;
    const mock='globalThis.fetch = async () => { throw new Error("offline"); };';
    const proc=spawnSync(process.execPath,[
      '--import','data:text/javascript,'+encodeURIComponent(mock),
      path.join(root,'scripts/enrich-artist-images.mjs')
    ],{encoding:'utf8',timeout:15000});
    assert.ifError(proc.error);
    assert.equal(proc.status,0,proc.stderr);
    assert.match(proc.stdout,/Found 0, no exact match 0, errors 1\./);
    assert.match(proc.stderr,/Lookup failed for "Example Band": offline/);
    const after=await readFile(target,'utf8');
    assert.equal(after,before);
    assert.equal(JSON.parse(after).meta.lastUpdated,'2020-01-02T03:04:05.000Z');
    assert.equal((await stat(target)).mtimeMs,modifiedBefore);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
