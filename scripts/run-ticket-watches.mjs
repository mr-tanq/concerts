import { readFile } from 'node:fs/promises';
import { createPrivateWatchStore } from '../js/private-ticket-watch.js';
import { creditPolicy, createWorkerRequest, readCreditLedger } from './lib/ticketswap-worker.mjs';
import { spendableCredits } from './lib/ticketswap-budget.mjs';
import { runTicketWatches } from './lib/ticket-watch-runner.mjs';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
const options = process.argv.slice(2);
if (options.some(option => !['--live', '--full-market', '--enrich', '--publish-preview'].includes(option))) {
  throw new Error('Unknown Smart Ticket Watch option');
}
const live = options.includes('--live');
const publish = live || options.includes('--publish-preview');
const enabled = process.env.TICKETSWAP_WATCH_ENABLED === 'true'
  && process.env.TICKETSWAP_WATCH_CONTRACTS_VERIFIED === 'true';
if (live && (!enabled || !process.env.GITHUB_REPOSITORY_OWNER
  || process.env.GITHUB_ACTOR !== process.env.GITHUB_REPOSITORY_OWNER
  || process.env.GITHUB_TRIGGERING_ACTOR !== process.env.GITHUB_REPOSITORY_OWNER)) {
  throw new Error('Live Smart Ticket Watch requires an enabled, owner-initiated dispatch.');
}

const repository = process.env.TICKET_WATCH_PRIVATE_REPOSITORY;
const token = process.env.TICKET_WATCH_PRIVATE_TOKEN;
if ((repository || token) && !(repository && token)) throw new Error('Private Watch storage is incomplete.');
const privateStore = repository && createPrivateWatchStore({ repository, token });
if (!privateStore && publish) {
  if (live) throw new Error('Private Watch storage is required for live monitoring.');
  console.log('Private Watch storage is not configured. No Watch data was changed.');
  process.exit(0);
}

const empty = { json: { version: 1, entries: {} } };
const [planned, snapshot, official, ledger, preferences, state] = await Promise.all([
  read('data/planned.json'), read('data/ticketswap.json'), read('data/official-ticket-offers.json'),
  readCreditLedger(), privateStore ? privateStore.read('preferences') : empty,
  privateStore ? privateStore.read('state') : empty
]);
const validStore = value => value?.version === 1 && value.entries
  && typeof value.entries === 'object' && !Array.isArray(value.entries);
if (![snapshot, official].every(validStore) || !Array.isArray(planned.concerts)) throw new Error('Invalid watch data');

const policy = creditPolicy();
if (!Object.values(policy).every(value => Number.isSafeInteger(value) && value >= 0)) {
  throw new Error('Invalid TicketSwap credit configuration');
}
const now = Date.now();
// Open and verify the private store before even creating the paid request worker.
const request = live ? await createWorkerRequest({ watch: true }) : undefined;
const result = await runTicketWatches({
  concerts: planned.concerts, watches: preferences.json, state: state.json, snapshot, official, now, request,
  refreshWatches: live ? async () => (await privateStore.read('preferences')).json : undefined,
  spendableCredits: spendableCredits(ledger, policy, now),
  mode: options.includes('--full-market') ? 'FULL_MARKET' : 'AVAILABLE_ONLY',
  enrich: options.includes('--enrich')
});
result.estimate = { ...result.estimate, enabled, reserve: policy.reserve,
  dailyLimit: policy.daily, monthlyLimit: policy.monthly, estimatedAt: result.updatedAt };
if (publish) {
  await privateStore.write('state', result, state.sha);
  console.log('Watch preview or observations saved privately.');
} else {
  console.log(JSON.stringify(result.estimate, null, 2));
}
