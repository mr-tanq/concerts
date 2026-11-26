import { localDate } from '../js/concert-schedule.js';
import { readJSON, updateOfficialTicketStore } from './lib/official-ticket-store.mjs';
import { refreshOfficialTickets } from './lib/official-ticket-refresh.mjs';
import { officialTicketSources } from './sources/official-ticket-providers.mjs';
import { createOfficialPageReader } from './sources/official-ticket-http.mjs';

const [, , concertId, mode] = process.argv;
if (!concertId || (mode && mode !== '--live')) {
  throw new Error('Usage: node scripts/refresh-official-tickets.mjs CONCERT_ID [--live]');
}
const [planned, resale] = await Promise.all([readJSON('data/planned.json'), readJSON('data/ticketswap.json')]);
const concert = planned.concerts.find(item => item.id === concertId);
const today = localDate(Date.now(), 'Europe/Amsterdam');
if (!concert || (concert.endDate || concert.date) < today) throw new Error('Choose an upcoming planned concert');

const sources = officialTicketSources(concert);
for (const source of sources) console.log(source.provider, source.url);
if (!sources.length) {
  console.log('No supported official event URL is recorded for this concert.');
} else if (mode !== '--live') {
  console.log('Dry run: no requests or snapshot writes.');
} else {
  const mappings = await readJSON('data/official-ticket-category-mappings.json').catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (!Array.isArray(mappings)) throw new Error('Invalid official category mappings');
  await updateOfficialTicketStore(async store => {
    const result = await refreshOfficialTickets({
      store, concert, resale: resale.entries[concertId], mappings, readPage: createOfficialPageReader()
    });
    console.log('Official ticket check:', result.status);
    return result.store;
  });
}
