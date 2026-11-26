import { pathToFileURL } from 'node:url';
import { endpointCosts } from './lib/ticketswap-budget.mjs';

export function ticketWatchValidationPlan() {
  const steps = [
    { endpoint: 'get_market_batch', mode: 'AVAILABLE_ONLY', limit: 5 },
    { endpoint: 'get_market_batch', mode: 'FULL_MARKET', limit: 5 },
    { endpoint: 'get_event_demand' },
    { endpoint: 'get_events_sold_sample', rowsPerEvent: 5 },
    { endpoint: 'get_events_sold_sample', rowsPerEvent: 5, onlyWithReturnedCursor: true }
  ].map(step => ({ ...step, maxDocumentedCredits: endpointCosts[step.endpoint] }));
  return {
    mode: 'offline plan only',
    requiresSeparateOwnerApproval: true,
    maximumCalls: steps.length,
    maximumDocumentedCredits: steps.reduce((sum, step) => sum + step.maxDocumentedCredits, 0),
    retries: 0,
    steps
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(ticketWatchValidationPlan(), null, 2));
}
