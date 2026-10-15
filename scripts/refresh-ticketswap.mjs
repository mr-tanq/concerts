import { selectRequestedConcerts } from './lib/ticketswap-requests.mjs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { ticketSwapRequest } from './lib/ticketswap-api.mjs';
import { selectConcerts, checkConcert } from './lib/ticketswap-going.mjs';

const live = process.argv.includes('--live');
const limit = Number(process.env.TICKETSWAP_LIMIT || 3);

if (!Number.isInteger(limit) || limit < 1 || limit > 3) {
  throw new Error('Limit must be 1–3');
}

const planned = JSON.parse(await readFile('data/planned.json', 'utf8'));
if (!Array.isArray(planned.concerts)) throw new Error('Invalid Going data');

let snapshot;
try {
  snapshot = JSON.parse(await readFile('data/ticketswap.json', 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  snapshot = { version: 1, entries: {} };
}

if (snapshot.version !== 1 || !snapshot.entries
  || typeof snapshot.entries !== 'object'
  || Array.isArray(snapshot.entries)) {
  throw new Error('Invalid TicketSwap data');
}

const now = new Date();
const requestedMode = process.env.TICKETSWAP_REQUESTS === 'true';
let requests = {};
if (requestedMode) {
  const queue = JSON.parse(
    await readFile('data/ticketswap-requests.json', 'utf8')
  );
  if (queue.version !== 1 || !queue.requests
    || typeof queue.requests !== 'object'
    || Array.isArray(queue.requests)) {
    throw new Error('Invalid request queue');
  }
  requests = queue.requests;
}
const selected = requestedMode
  ? selectRequestedConcerts(planned.concerts, snapshot.entries, requests, now)
  : selectConcerts(planned.concerts, snapshot.entries, now, limit);

console.table(selected.map(c => ({
  artist: c.artist,
  date: c.date,
  venue: c.venue
})));

if (!live) {
  console.log('DRY RUN OK — no API calls, no credits used, no data written.');
} else if (selected.length) {
  if (!process.env.PARSE_API_KEY) throw new Error('Missing PARSE_API_KEY');

  for (const c of selected) {
    snapshot.entries[c.id] = await checkConcert(
      c, snapshot.entries[c.id], ticketSwapRequest, now,
      requestedMode ? requests[c.id].selectedEventId : null
    );
    if (requestedMode) {
      snapshot.entries[c.id].requestId = requests[c.id].requestId;
    }
    console.log(c.artist, snapshot.entries[c.id].status);
  }

  snapshot.updatedAt = now.toISOString();
  await writeFile('data/ticketswap.json.tmp', JSON.stringify(snapshot, null, 2) + '\n');
  await rename('data/ticketswap.json.tmp', 'data/ticketswap.json');
}
