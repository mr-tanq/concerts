import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseFestivalEvents} from './sources/festivalinfo.mjs';
import {cacheFestivalImages} from './cache-festival-images.mjs';
import {festivalArtworkMatchesEdition} from '../js/festival-artwork.js';
const url='https://www.festivalinfo.nl/festival/36695/Roadburn/2027/';
const e={'@type':'Festival',name:'Roadburn',url,startDate:'2027-04-15',endDate:'2027-04-18',location:{name:'Roadburn',address:{addressLocality:'Tilburg',addressCountry:'NL'}},performer:[{name:'Neurosis'}]};
const html=extra=>`<script type="application/ld+json">${JSON.stringify(e)}</script>${extra||''}`;
const image=page=>parseFestivalEvents(page,url)[0].image;
test('finds current edition artwork in lazy news images, not a band or other festival',()=>{
  const page=html(`<section class="news"><article><img data-src="/img/artist/1/Neurosis.jpg" alt="Neurosis"></article><article><img data-src="/img/upload/roadburn_2026.jpg" alt="Roadburn 2026"></article><article><img data-src="/img/upload/other_2027.jpg" alt="Other 2027"></article><article><img src="/img/trans.png" data-src="/img/upload/roadburn_2027.jpg" alt="Roadburn 2027"></article></section>`);
  assert.equal(image(page),'https://www.festivalinfo.nl/img/upload/roadburn_2027.jpg');
});
test('recognises metadata and image arrays, rejecting site logo and placeholders',()=>{
  assert.equal(image(html('<meta property="og:image" content="/img/upload/cover.jpg">')),'https://www.festivalinfo.nl/img/upload/cover.jpg');
  assert.equal(image(html().replace(JSON.stringify(e),JSON.stringify({...e,image:[{url:'https://cdn.example.com/cover.jpg'}]}))),'https://cdn.example.com/cover.jpg');
  assert.equal(image(html('<meta property="og:image" content="/img/logo.png">')),null);
  assert.equal(image(html('<section class="news"><article><img data-src="javascript:alert(1)" alt="Roadburn 2027"></article></section>')),null);
});
test('only an exact edition link can supply a sidebar logo',()=>{
  assert.equal(image(html(`<a href="${url.replace('36695','99')}"><img data-src="/img/upload/other.jpg"></a><a href="${url}"><img data-src="/img/upload/cover.jpg"></a>`)),'https://www.festivalinfo.nl/img/upload/cover.jpg');
});
test('backfills old null-image records by verified edition and preserves all other data',async()=>{
  const records=[{isFestival:true,sourceUrl:url,artist:'Roadburn',image:null,notes:'Keep',practical:{ticketBought:true}}],before=JSON.stringify(records);
  const r=await cacheFestivalImages(records,{}, {now:100000, pause:async()=>{},fetcher:async()=>html('<meta property="og:image" content="/img/upload/cover.jpg">')});
  assert.equal(r.editions[url].image,'https://www.festivalinfo.nl/img/upload/cover.jpg');assert.equal(JSON.stringify(records),before);
  let requests=0;await cacheFestivalImages(records,r,{now:100001,pause:async()=>{},fetcher:async()=>{requests++;throw Error();}});assert.equal(requests,0);
});
test('photo-source failure preserves the last saved image and ignores unsafe edition URLs',async()=>{
  const previous={editions:{[url]:{image:'https://cdn.example.com/old.jpg',checkedAt:0}}};let requests=0;
  const r=await cacheFestivalImages([{isFestival:true,sourceUrl:url},{isFestival:true,sourceUrl:'https://evil.test/'}],previous,{pause:async()=>{},fetcher:async()=>{requests++;throw Error('offline');}});
  assert.equal(requests,1);assert.equal(r.editions[url].image,'https://cdn.example.com/old.jpg');
});
const app=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const functionText=app.slice(app.indexOf('function imageFor(rec)'),app.indexOf('// Photos are applied',app.indexOf('function imageFor(rec)')));
const ctx={festivalArtworkMatchesEdition,normalizeKey:s=>s.toLowerCase(),artistImages:new Map([['roadburn','https://cdn.example.com/wrong-band.jpg']]),festivalImages:new Map([[url,'https://cdn.example.com/festival.jpg']]),concertImageByArtist:new Map(),concertImageBySourceId:new Map(),concertImageByVenueDate:new Map()};vm.createContext(ctx);vm.runInContext(functionText,ctx);
test('festival artwork and saved fallback take priority over artist-photo matches',()=>{
  assert.equal(ctx.imageFor({isFestival:true,artist:'Roadburn',sourceUrl:url,date:'2027-04-15'}),'https://cdn.example.com/festival.jpg');
  assert.equal(ctx.imageFor({isFestival:true,artist:'Roadburn',sourceUrl:url,date:'2027-04-15',image:'https://cdn.example.com/new.jpg'}),'https://cdn.example.com/festival.jpg');
  assert.equal(ctx.imageFor({isFestival:true,artist:'Roadburn',date:'2027-04-15',sourceUrl:'https://example.com/unknown'}),null);
  assert.equal(ctx.imageFor({artist:'Roadburn'}),'https://cdn.example.com/wrong-band.jpg');
});


test('current edition poster wins over generic images and older-year logos',()=>{
  const oldStructured={...e,image:'https://example.com/Roadburn_2026_logo.jpg'};
  const p=html('<meta property="og:image" content="https://festivalinfo.nl/img/upload/cover.jpg"><section class="news"><article><img alt="Roadburn 2026" src="/img/upload/Roadburn_2026.jpg"></article><article><img alt="Roadburn 2027" src="/img/upload/Roadburn_2027.jpg"></article></section>')
    .replace(JSON.stringify(e),JSON.stringify(oldStructured));
  assert.equal(image(p),'https://www.festivalinfo.nl/img/upload/Roadburn_2027.jpg');
  assert.equal(image(html().replace(JSON.stringify(e),JSON.stringify(oldStructured))),null);
  assert.equal(festivalArtworkMatchesEdition('https://cdn.test/Helldorado_2025_logo.jpg','2026-11-14'),false);
  assert.equal(festivalArtworkMatchesEdition('https://cdn.test/Helldorado_2026.jpg','2026-11-14'),true);
  assert.equal(festivalArtworkMatchesEdition('https://cdn.test/poster.jpg','2026-11-14'),true);
  assert.equal(festivalArtworkMatchesEdition('https://cdn.test/%ZZ','2026-11-14'),false);
});
test('edition image cache is refreshed when previous version is obsolete',async()=>{
  const prior={editions:{[url]:{image:'https://cdn.test/Roadburn_2026.jpg',imageVersion:1,checkedAt:100000}}};
  let fetched=0;
  const next=await cacheFestivalImages([{isFestival:true,sourceUrl:url,date:'2027-04-15'}],prior,{
    now:100001,pause:async()=>{},fetcher:async()=>{fetched++;return html('<meta property="og:image" content="/img/upload/Roadburn_2027.jpg">');}
  });
  assert.equal(fetched,1);assert.equal(next.editions[url].imageVersion,2);
  assert.equal(next.editions[url].image,'https://www.festivalinfo.nl/img/upload/Roadburn_2027.jpg');
});
test('app rejects a wrong-year fallback even when an old planned record still holds it',()=>{
  const item={isFestival:true,artist:'Roadburn',date:'2027-04-15',sourceUrl:'https://example.com/other',image:'https://cdn.test/Roadburn_2026_logo.jpg'};
  assert.equal(ctx.imageFor(item),null);
  assert.equal(ctx.imageFor({...item,image:'https://cdn.test/Roadburn_2027_logo.jpg'}),'https://cdn.test/Roadburn_2027_logo.jpg');
});


test('a missing edition poster uses a matched band portrait with no invented festival art',()=>{
  ctx.artistImages.set('mono','https://cdn.example.com/mono.jpg');
  const item={isFestival:true,artist:'Roadburn',date:'2027-04-15',sourceUrl:'https://example.com/unknown',
    image:null,matchedArtists:['MONO']};
  assert.equal(ctx.imageFor(item),'https://cdn.example.com/mono.jpg');
  assert.equal(ctx.imageFor({...item,matchedArtists:['Band without photo']}),null);
});
test('artwork refresh monitors Set aside and catalog entries, not just planned shows',async()=>{
  const script=await readFile(new URL('./cache-festival-images.mjs',import.meta.url),'utf8');
  assert.match(script,/data\/recommendation-history\.json/);
  assert.match(script,/data\/festivalinfo-cache\.json/);
  assert.match(script,/fromCache/);
});
