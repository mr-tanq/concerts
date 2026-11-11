import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as cheerio from 'cheerio';
import {readFile} from 'node:fs/promises';
import {usableConcertImage,podiuminfoArtistImage} from '../js/concert-image-quality.js';
import {extractArtistImage} from './sources/podiuminfo.mjs';

const bad='https://www.podiuminfo.nl/img/podiuminfo-rond.png';
const good='https://cdn-images.dzcdn.net/images/artist/bb3281b6a242c5d535851670f03f1278/1000x1000-000000-80-0-0.jpg';
const oldArtist='https://www.festivalinfo.nl/img/artist/94678/100_The_Dead_South_7.jpg';
const concert={artist:'Boogie Belgique',source:'podiuminfo',sourceId:'502384',
  id:'planned-podiuminfo-502384',date:'2027-05-01',venue:'TivoliVredenburg',
  city:'Utrecht',isFestival:false,image:bad};

test('source logos, social badges and placeholders cannot masquerade as live photos',()=>{
  for(const src of [
    bad,'https://www.festivalinfo.nl/img/festivalinfo-rond.png',
    'https://www.podiuminfo.nl/favicon.ico',
    'https://example.com/placeholder.jpg',
    'https://example.com/default-image.png',
    'https://example.com/facebook-logo.jpg',
    'http://example.com/photo.jpg','javascript:alert(1)'
  ])assert.equal(usableConcertImage(src),null,src);
  assert.equal(usableConcertImage(good),good);
  assert.equal(usableConcertImage(oldArtist),oldArtist);
});
test('podiuminfo parser ignores generic embedded map marker',()=>{
  const html='<div><img src="/img/podiuminfo-rond.png"></div>'+
    '<div data-marker="markerimage='+bad+'"></div>';
  assert.equal(extractArtistImage(cheerio.load(html),html),null);
});
test('parser accepts a genuinely identified artist image, but not logo or unrelated domains',()=>{
  const html='<a href="/artist/1234/Boogie-Belgique"><img src="/img/artist/1234/100_Boogie_Belgique_1.jpg"></a>';
  assert.equal(extractArtistImage(cheerio.load(html),html),
    'https://www.podiuminfo.nl/img/artist/1234/100_Boogie_Belgique_1.jpg');
  assert.equal(podiuminfoArtistImage(bad),null);
  assert.equal(podiuminfoArtistImage(good),null);
});
const app=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const from=app.indexOf('function imageFor(rec)');
const until=app.indexOf('// Photos are applied',from);
const photoFn=app.slice(from,until);
const setFrom=app.indexOf('function setPhoto(node, url, record=null)');
const setUntil=app.indexOf('// Deezer enrichment',setFrom);
const setFn=app.slice(setFrom,setUntil);

test('a saved Boogie Belgique logo can never override valid Deezer cover art',()=>{
  const map=new Map(),ctx={
    usableConcertImage,festivalArtworkMatchesEdition:()=>false,
    normalizeKey:s=>String(s||'').toLowerCase().trim(),
    festivalImages:new Map(),artistImages:map,
    concertImageByArtist:new Map([['boogie belgique',bad]]),
    concertImageBySourceId:new Map([['502384',bad]]),
    concertImageByVenueDate:new Map([['tivolivredenburg|2027-05-01',bad]])
  };
  vm.createContext(ctx);vm.runInContext(photoFn,ctx);
  assert.equal(ctx.imageFor(concert),null);
  map.set('boogie belgique',good);
  assert.equal(ctx.imageFor(concert),good);
});
test('mounted sheet image can be replaced without resetting its content',()=>{
  const ctx={usableConcertImage,normalizeKey:s=>String(s||'').toLowerCase().trim()};
  vm.createContext(ctx);vm.runInContext(setFn,ctx);
  const classes=new Set();
  const node={dataset:{},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},
    style:{backgroundImage:'',removeProperty:function(n){if(n==='background-image')this.backgroundImage='';}}};
  assert.equal(ctx.setPhoto(node,bad,concert),false);
  assert.equal(node.dataset.photoArtist,'boogie belgique');
  assert.equal(classes.has('is-empty'),true);
  assert.equal(ctx.setPhoto(node,good),true);
  assert.equal(classes.has('is-empty'),false);
  assert.ok(node.style.backgroundImage.includes('bb3281b6'));
});
test('Going waits for asynchronously enriched photos and updates visible cards',()=>{
  assert.match(app,/loadJSON\('data\/artist-images\.json\?refresh='\+Date\.now\(\)\)/);
  assert.match(app,/repaintNewArtistPhotos\(\)/);
  assert.match(app,/querySelectorAll\('\[data-photo-artist\]'\)/);
  assert.match(app,/watchForNewArtistPhotos\(\)/);
  assert.match(app,/ARTIST_PHOTO_RETRY_LIMIT=8/);
  assert.match(app,/setPhoto\(sheet\.querySelector\("\.sheet-photo"\), photo, c\)/);
});
