import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichOne} from './enrich-concert-schedules.mjs';
import {discoverSchedulePages} from './sources/schedule-discovery.mjs';
const c={id:'planned-test',artist:'Test Artist',date:'2026-10-23',venue:'TivoliVredenburg',city:'Utrecht',country:'NL',supportingArtists:[]};
const stamp='2026-10-18T04:30:00.000Z';
const root='https://tivolivredenburg.nl';
const event='/agenda/123/test-artist-23-10-2026';
const page=(date=c.date,support='Guest Band')=>`<html><head><title>Test Artist - TivoliVredenburg</title></head><body><main><h2>Test Artist</h2><time datetime="${date}">${date}</time><dl><dd>19:30</dd><dt class="description-list__term--group">Deuren open</dt><dd>20:30</dd><dt class="description-list__term--group">Aanvang</dt><dt>Support act</dt><dd>${support}</dd></dl></main></body></html>`;
function fetcher(routes){const calls=[];const fn=async(url,hosts)=>{calls.push(url);assert.ok(hosts.includes('tivolivredenburg.nl'));if(!Object.hasOwn(routes,url))throw new Error('HTTP 404');return{url,html:routes[url]}};fn.calls=calls;return fn;}

test('numbered agenda pages find an event omitted from page one and use support metadata',async()=>{
 const f=fetcher({[root+'/agenda/']:'<a href="/agenda/other">Other</a>',[root+'/agenda/page/2/']:'No match',[root+'/agenda/page/3/']:`<a href="${event}">Test Artist</a>`,[root+event]:page()});
 const s=await enrichOne(c,stamp,'manual',f);
 assert.equal(s.doors.time,'19:30');assert.equal(s.support[0].name,'Guest Band');assert.equal(s.support[0].time,'20:30');assert.equal(s.main.time,null);assert.equal(s.checkStatus,'official');assert.equal(s.lastAttemptAt,stamp);
 assert.ok(f.calls.includes(root+'/agenda/page/3/'));assert.ok(!f.calls.includes(root+'/agenda/page/4/'));
});
test('wrong concert dates and unrelated artists are rejected',async()=>{
 const wrong=event.replace('23-10','24-10');
 const f=fetcher({[root+'/agenda/']:`<a href="${wrong}">Test Artist</a><a href="${event}">Test Artist</a><a href="/agenda/unrelated">Someone Else</a>`,[root+wrong]:page('2026-10-24'),[root+event]:page()});
 const s=await enrichOne(c,stamp,'manual',f);assert.equal(s.doors.time,'19:30');assert.ok(!f.calls.includes(root+'/agenda/unrelated'));
 const onlyWrong=fetcher({[root+'/agenda/']:`<a href="${wrong}">Test Artist</a>`,[root+wrong]:page('2026-10-24')});
 const missing=await enrichOne(c,stamp,'manual',onlyWrong);assert.equal(missing.doors.time,null);assert.equal(missing.checkStatus,'failed');
});
test('an official next-page link works without a page-number URL',async()=>{
 const f=fetcher({[root+'/agenda/']:'<a rel="next" href="/agenda/?cursor=next">More</a>',[root+'/agenda/?cursor=next']:`<a href="${event}">Test Artist</a>`,[root+event]:page()});
 const s=await enrichOne(c,stamp,'manual',f);assert.equal(s.doors.time,'19:30');assert.ok(f.calls.includes(root+'/agenda/?cursor=next'));
});
test('missing sitemap.xml falls back to a sitemap index and child sitemap',async()=>{
 const f=fetcher({[root+'/sitemap_index.xml']:`<sitemapindex><sitemap><loc>${root}/event-sitemap.xml</loc></sitemap></sitemapindex>`,[root+'/event-sitemap.xml']:`<urlset><url><loc>${root+event}</loc></url></urlset>`,[root+event]:page()});
 const s=await enrichOne(c,stamp,'manual',f);assert.equal(s.doors.time,'19:30');assert.ok(f.calls.includes(root+'/event-sitemap.xml'));
});
test('external event and pagination links are never requested',async()=>{
 const f=fetcher({[root+'/agenda/']:'<a href="https://evil.test/test-artist">Test Artist</a><a rel="next" href="https://evil.test/agenda/">Next</a>',[root+'/sitemap_index.xml']:'<sitemapindex><sitemap><loc>https://evil.test/events.xml</loc></sitemap></sitemapindex>'});
 const s=await enrichOne(c,stamp,'manual',f);assert.equal(s.checkStatus,'failed');assert.ok(f.calls.every(u=>new URL(u).hostname==='tivolivredenburg.nl'));
});
test('cached discovery pages are reused for another concert at the same venue',async()=>{
 const second={...c,artist:'Second Artist'};const other='/agenda/456/second-artist-23-10-2026';
 const f=fetcher({[root+'/agenda/']:`<a href="${event}">Test Artist</a><a href="${other}">Second Artist</a>`,[root+event]:page(),[root+other]:page().replaceAll('Test Artist','Second Artist')});
 assert.equal((await enrichOne(c,stamp,'manual',f)).doors.time,'19:30');assert.equal((await enrichOne(second,stamp,'manual',f)).doors.time,'19:30');assert.equal(f.calls.filter(u=>u===root+'/agenda/').length,1);
});
test('no-support metadata keeps programme start assigned to main act',async()=>{
 const f=fetcher({[root+'/agenda/']:`<a href="${event}">Test Artist</a>`,[root+event]:page(c.date,'Geen voorprogramma')});
 const s=await enrichOne(c,stamp,'manual',f);assert.equal(s.main.time,'20:30');assert.equal(s.support.length,0);assert.equal(s.noSupport.kind,'official');
});
test('failed discovery preserves earlier confirmed times',async()=>{
 const f=fetcher({});const previous={...c,schedule:{date:c.date,doors:{name:'DOORS',time:'19:00',sourceUrl:root+event,sourceKind:'official',checkedAt:'2026-10-17T12:00:00Z'},lastCheckedAt:'2026-10-17T12:00:00Z'}};
 const s=await enrichOne(previous,stamp,'manual',f);assert.equal(s.doors.time,'19:00');assert.equal(s.lastCheckedAt,previous.schedule.lastCheckedAt);assert.equal(s.checkStatus,'failed');
});
test('cyclic pagination and sitemap indexes stay within request limits',async()=>{
 const calls=[];const f=async(url)=>{calls.push(url);if(url.includes('sitemap'))return{url,html:`<sitemapindex><sitemap><loc>${root}/sitemap_index.xml</loc></sitemap><sitemap><loc>${root}/other-sitemap.xml</loc></sitemap></sitemapindex>`};return{url,html:'<a rel="next" href="/agenda/">Next</a>'}};
 assert.equal(await discoverSchedulePages(c,['TivoliVredenburg','tivolivredenburg.nl','/agenda/'],f,()=>false),false);assert.ok(calls.length<=16);assert.equal(new Set(calls).size,calls.length);
});
