import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVenueParent,createVenueParentLookup
} from './lib/setlist-venue-parent.mjs';
import {resolveSetlist} from './lib/setlist-resolver.mjs';

const venue={
  id:'abcd123',name:'Stage 1',
  url:'https://www.setlist.fm/venue/room-city-netherlands-abcd123.html'
};
const finalURL='https://www.setlist.fm/venue/parent-city-netherlands-beef123.html?venue=abcd123';
const html=`<a href="/other">Unrelated</a>
<h1>Stage 1 at Parent City Concert Setlists</h1>
<div class="subVenues">
<a href="../venue/parent-city-netherlands-beef123.html?venue=beef123">
<span>Parent</span></a> (main venue)</div>`;

const c={
  artist:'Band',date:'2026-10-10',
  venue:'Parent',city:'City',country:'NL'
};
const item=(id='night')=>({
  id,url:`https://www.setlist.fm/setlist/${id}.html`,
  artist:{name:'Band'},eventDate:'10-10-2026',
  venue:{...venue,city:{name:'City',country:{code:'NL'}}},
  sets:{set:[{song:[{name:'Song'}]}]}
});
const api=async()=>({setlist:[item()]});
const now=Date.parse('2026-10-16');

test('reads explicit main venue link, not unrelated page links',()=>{
  const p=parseVenueParent(html,finalURL,venue);
  assert.equal(p.name,'Parent');
  assert.equal(p.childId,venue.id);
});

test('rejects wrong room id, heading, host and missing parent relation',()=>{
  for(const [markup,url] of [
    [html,finalURL.replace('abcd123','dead123')],
    [html.replace('Stage 1 at','Stage 2 at'),finalURL],
    [html,finalURL.replace('www.setlist.fm','evil.example')],
    [html.replace('(main venue)',''),finalURL]
  ]) assert.equal(parseVenueParent(markup,url,venue),null);
});

test('decodes parent names and requires one unambiguous relation',()=>{
  const p=parseVenueParent(
    html.replaceAll('Parent','A &amp; B'),finalURL,venue
  );
  assert.equal(p.name,'A & B');
  assert.equal(parseVenueParent(html+html,finalURL,venue),null);
});

test('lookup caches requests; does not fetch unrelated hosts',async()=>{
  let requests=0;
  const lookup=createVenueParentLookup(async()=>{
    requests++;
    return {html,url:finalURL};
  });
  assert.equal((await lookup(venue)).name,'Parent');
  await lookup(venue);
  assert.equal(requests,1);
  assert.equal(await lookup({
    ...venue,url:'https://evil.example/venue/foo.html'
  }),null);
  assert.equal(requests,1);
});

test('verified room-to-parent relationship yields exact concert',async()=>{
  const lookup=async()=>parseVenueParent(html,finalURL,venue);
  const r=await resolveSetlist(c,'Band',api,now,lookup);
  assert.equal(r.matchType,'exact');
  assert.equal(r.venueEvidence.name,'Parent');
  assert.equal(r.sourceEvent.venue,'Stage 1');
  assert.equal(r.matchingVersion,3);
});

test('same city alone, another room, date or artist never proves venue',async()=>{
  const proof=parseVenueParent(html,finalURL,venue);
  for(const concert of [
    {...c,venue:'Other'},
    {...c,venue:'Parent Stage 2'},
    {...c,city:'Other'},
    {...c,country:'BE'},
    {...c,date:'2026-10-09'},
    {...c,artist:'Other'}
  ]) assert.equal(await resolveSetlist(
    concert,concert.artist,api,now,async()=>proof
  ),null);

  assert.equal(await resolveSetlist(
    c,'Band',api,now,async()=>null
  ),null);
});

test('parent page failures propagate, preserving snapshot error handling',async()=>{
  await assert.rejects(resolveSetlist(
    c,'Band',api,now,async()=>{throw Error('HTTP 403');}
  ));
});

test('two matching rooms are ambiguous',async()=>{
  const proof=parseVenueParent(html,finalURL,venue);
  assert.equal(await resolveSetlist(
    c,'Band',
    async()=>({setlist:[item('one'),item('two')]}),
    now,async()=>proof
  ),null);
});
