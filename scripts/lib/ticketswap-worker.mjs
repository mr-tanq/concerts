import { execFile } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { promisify } from 'node:util';
import { ticketSwapRequest } from './ticketswap-api.mjs';
import { createBudgetedRequest, emptyLedger } from './ticketswap-budget.mjs';

const git = promisify(execFile);
const path = 'data/ticketswap-credits.json';

export async function createWorkerRequest() {
  if (!process.env.PARSE_API_KEY) throw new Error('Missing PARSE_API_KEY');
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Use the serialized main-branch workflow for live TicketSwap requests');
  }

  let ledger;
  try {
    ledger = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ledger = emptyLedger();
  }

  return createBudgetedRequest({
    ledger,
    policy: {
      initial: Number(process.env.TICKETSWAP_INITIAL_CREDITS || 194),
      daily: Number(process.env.TICKETSWAP_DAILY_LIMIT || 8),
      monthly: Number(process.env.TICKETSWAP_MONTHLY_LIMIT || 40),
      reserve: Number(process.env.TICKETSWAP_CREDIT_RESERVE || 20)
    },
    trustHeaders: process.env.TICKETSWAP_TRUST_CREDIT_HEADERS === 'true',
    transport: ticketSwapRequest,
    persist: async value => {
      await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n');
      await rename(path + '.tmp', path);
      await git('git', ['add', '--', path]);
      const { stdout } = await git('git', ['diff', '--cached', '--name-only', '--', path]);
      if (!stdout.trim()) return;
      await git('git', ['commit', '-m', 'Record TicketSwap credit usage', '--', path]);
      // Other app actions can advance main. A ledger conflict aborts the request.
      await git('git', ['pull', '--rebase', 'origin', 'main']);
      await git('git', ['push', 'origin', 'HEAD:main']);
    }
  });
}
