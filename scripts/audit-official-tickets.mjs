#!/usr/bin/env node
// audit-official-tickets.mjs
//
// A bounded, one-shot live audit of official ticket sources for upcoming
// planned concerts. For each concert it resolves the official seller (never
// following robots-disallowed intermediary links), then reads the verified
// official sources for price, fees, categories and availability.
//
//   node scripts/audit-official-tickets.mjs [--only REGEX] [--limit N]
//        [--report path.json] [--write]
//
// Without --write nothing in data/ changes. With --write the verified seller
// destinations and observations are saved to data/official-ticket-offers.json
// (the same store the on-demand check writes). No schedule, no TicketSwap or
// Parse.bot request, no checkout, account or purchase request is ever made.
// Requests are paced per host and respect robots.txt; access controls
// (challenges, 401/403) and 429s stop requests to that host.

import { writeFile } from 'node:fs/promises';
import { localDate } from '../js/concert-schedule.js';
import { classifyTicketLink } from '../js/ticket-links.js';
import { readJSON, updateOfficialTicketStore } from './lib/official-ticket-store.mjs';
import { refreshOfficialTickets } from './lib/official-ticket-refresh.mjs';
import { createOfficialPageReader } from './sources/official-ticket-http.mjs';
import { resolveOfficialSeller, scheduleDiscovery } from './sources/official-ticket-sellers.mjs';
import { enrichOne } from './enrich-concert-schedules.mjs';

const argument = name => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : null;
};
const only = argument('--only') ? new RegExp(argument('--only')) : null;
const limit = Math.min(Number(argument('--limit') ?? 101) || 101, 150);
const reportPath = argument('--report');
const write = process.argv.includes('--write');

const [planned, resale, initial] = await Promise.all([
  readJSON('data/planned.json'), readJSON('data/ticketswap.json'), readJSON('data/official-ticket-offers.json')
]);
const today = localDate(Date.now(), 'Europe/Amsterdam');
const concerts = planned.concerts.filter(concert => (concert.endDate || concert.date) >= today
  && (!only || only.test(concert.id) || only.test(concert.ticketUrl ?? 'none'))).slice(0, limit);

const reader = createOfficialPageReader();
const discover = scheduleDiscovery(enrichOne);
let store = initial;
const rows = [];
for (const concert of concerts) {
  const started = Date.now();
  let seller = null;
  const result = await refreshOfficialTickets({
    store, concert, resale: resale.entries[concert.id], readPage: reader,
    resolveSeller: async item => (seller = await resolveOfficialSeller({ concert: item, reader, discover }))
  }).catch(error => ({ store, status: 'error', error: error.message }));
  store = result.store;
  const record = store.entries[concert.id];
  const checks = Object.entries(record?.providerChecks ?? {});
  const offers = checks.filter(([, check]) => check.status === 'verified').flatMap(([, check]) => check.offers);
  const link = classifyTicketLink(concert.ticketUrl);
  rows.push({
    id: concert.id, artist: concert.artist, venue: concert.venue, date: concert.date,
    storedLink: link.kind === 'invalid' ? 'none' : `${link.kind}:${link.provider ?? new URL(link.url).hostname}`,
    seller: seller ?? record?.seller ?? null, check: result.status,
    sources: checks.map(([url, check]) => ({ url, status: check.status })),
    offers: offers.map(offer => ({
      provider: offer.provider, seller: offer.seller, category: offer.category, currency: offer.currency,
      listedCents: offer.listedCents, baseCents: offer.baseCents, feesCents: offer.feesCents,
      finalCents: offer.finalCents, availability: offer.availability, priceContext: offer.priceContext ?? null,
      purchaseUrl: offer.purchaseUrl
    })),
    ms: Date.now() - started
  });
  console.log(`${concert.id}: link ${rows.at(-1).storedLink}; seller ${rows.at(-1).seller?.status ?? '—'}`
    + ` ${rows.at(-1).seller?.provider ?? ''}; offers ${offers.length}; ${result.status}`);
}

const report = { auditedAt: new Date().toISOString(), concerts: rows.length, requests: reader.requestCount(), rows };
if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Requests: ${report.requests}`);
if (write) await updateOfficialTicketStore(current => {
  // Merge only this audit's concerts into the latest store.
  const entries = { ...current.entries };
  for (const row of rows) if (store.entries[row.id]) entries[row.id] = { ...entries[row.id], ...store.entries[row.id] };
  return { ...current, entries, providerBackoff: { ...current.providerBackoff, ...store.providerBackoff },
    updatedAt: new Date().toISOString() };
});
