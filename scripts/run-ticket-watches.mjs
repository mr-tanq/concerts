import { readFile, rename, writeFile } from 'node:fs/promises';
import { creditPolicy, createWorkerRequest, readCreditLedger } from './lib/ticketswap-worker.mjs';
import { spendableCredits } from './lib/ticketswap-budget.mjs';
import { runTicketWatches } from './lib/ticket-watch-runner.mjs';

const statePath = 'data/ticket-watch-state.json';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const options = process.argv.slice(2);
if (options.some(option => !['--live', '--full-market', '--enrich', '--publish-preview'].includes(option))) {
  throw new Error('Unknown Smart Ticket Watch option');
}
const live = options.includes('--live');
const enabled = process.env.TICKETSWAP_WATCH_ENABLED === 'true'
  && process.env.TICKETSWAP_WATCH_CONTRACTS_VERIFIED === 'true';
if (live && !enabled) throw new Error('Live Smart Ticket Watch is disabled');
const [planned, watches, state, snapshot, official, ledger] = await Promise.all([
  'data/planned.json', 'data/ticket-watches.json', statePath, 'data/ticketswap.json',
  'data/official-ticket-offers.json'
].map(read).concat(readCreditLedger()));

const validStore = value => value?.version === 1 && value.entries
  && typeof value.entries === 'object' && !Array.isArray(value.entries);
if (![watches, state, snapshot, official].every(validStore) || !Array.isArray(planned.concerts)) {
  throw new Error('Invalid watch data');
}
const policy = creditPolicy();
if (!Object.values(policy).every(value => Number.isSafeInteger(value) && value >= 0)) {
  throw new Error('Invalid TicketSwap credit configuration');
}
const now = Date.now();
const request = live ? await createWorkerRequest({ watch: true }) : undefined;
const result = await runTicketWatches({
  concerts: planned.concerts, watches, state, snapshot, official, now, request,
  spendableCredits: spendableCredits(ledger, policy, now),
  mode: options.includes('--full-market') ? 'FULL_MARKET' : 'AVAILABLE_ONLY',
  enrich: options.includes('--enrich')
});
result.estimate = { ...result.estimate, enabled, reserve: policy.reserve,
  dailyLimit: policy.daily, monthlyLimit: policy.monthly, estimatedAt: result.updatedAt };
console.log(JSON.stringify(result.estimate, null, 2));
if (live || (options.includes('--publish-preview')
  && (Object.keys(watches.entries).length || Object.keys(state.entries).length))) {
  await writeFile(statePath + '.tmp', JSON.stringify(result, null, 2) + '\n');
  await rename(statePath + '.tmp', statePath);
}
