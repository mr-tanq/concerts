import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConcert, identity } from './lib/ticketswap-going.mjs';

const concert={artist:'Example Band',date:'2027-03-20',venue:'Examplehouse',city:'Utrecht',country:'NL'};
const now=new Date('2026-11-13T22:00:00Z');
const event={
 __typename:'EventResult',id:'event-1',name:'Example Band',startDate:'2027-03-20T20:00:00+01:00',
 locationName:'Examplehouse',cityName:'Utrecht',country:{code:'NL'},
 uri:{url:'https://www.ticketswap.com/event/example-band'}
};
const previous=()=>({
 identity:identity(concert),event:{id:'event-1',url:'https://www.ticketswap.com/event/example-band',name:'Example Band'},
 status:'ok',availableTickets:2,lastError:null
});

test('provider search failure is not misreported as no tickets',async()=>{
 const r=await checkConcert(concert,null,async type=>{
  assert.equal(type,'search_events');throw new Error('secret provider text');
 },now);
 assert.equal(r.status,'error');
 assert.equal(r.errorPhase,'search');
 assert.equal(r.lastError,'TicketSwap event search failed');
 assert.doesNotMatch(JSON.stringify(r),/secret provider text/);
 assert.equal(r.availableTickets,undefined);
});

test('no matching event is distinct from a provider failure',async()=>{
 const r=await checkConcert(concert,null,async type=>{
  assert.equal(type,'search_events');return {results:[],page_info:{hasNextPage:false}};
 },now);
 assert.equal(r.status,'not-found');
 assert.equal(r.errorPhase,undefined);
 assert.equal(r.availableTickets,undefined);
});

test('incomplete search is not claimed to have no results',async()=>{
 const r=await checkConcert(concert,null,async()=>({results:[],page_info:{hasNextPage:true}}),now);
 assert.equal(r.status,'search-incomplete');
});

test('broken search schema is identified as a matching failure',async()=>{
 const r=await checkConcert(concert,null,async()=>({results:'not-an-array'}),now);
 assert.equal(r.status,'error');
 assert.equal(r.errorPhase,'matching');
 assert.equal(r.lastError,'TicketSwap event matching failed');
});

test('listings request error preserves previous safe availability for retry',async()=>{
 const r=await checkConcert(concert,previous(),async(type)=>{
  assert.equal(type,'get_event_listings');throw new Error('api key hidden');
 },now);
 assert.equal(r.status,'error');
 assert.equal(r.errorPhase,'listings');
 assert.equal(r.availableTickets,2);
 assert.equal(r.event.id,'event-1');
 assert.doesNotMatch(JSON.stringify(r),/api key hidden/);
});

test('invalid listing response cannot be mistaken for zero tickets',async()=>{
 const r=await checkConcert(concert,previous(),async()=>({event_id:'WRONG'}),now);
 assert.equal(r.status,'error');
 assert.equal(r.errorPhase,'validation');
 assert.equal(r.lastError,'TicketSwap listings response invalid');
 assert.equal(r.availableTickets,2);
});

test('invalid manual selection is caught before calling provider',async()=>{
 let calls=0;
 const r=await checkConcert(concert,previous(),async()=>{calls++;},now,'untrusted-id');
 assert.equal(calls,0);
 assert.equal(r.errorPhase,'selection');
});

test('successful listings clear old error diagnostics',async()=>{
 const old={...previous(),status:'error',errorPhase:'listings',lastError:'TicketSwap listing request failed'};
 const r=await checkConcert(concert,old,async()=>({
  event_id:'event-1',listing_status:'AVAILABLE',page_info:{has_next_page:false},listings:[]
 }),now);
 assert.equal(r.status,'ok');
 assert.equal(r.availableTickets,0);
 assert.equal(r.errorPhase,null);
 assert.equal(r.lastError,null);
});
