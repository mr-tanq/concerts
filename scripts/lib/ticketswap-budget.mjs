export const endpointCosts = Object.freeze({
  search_events: 1,
  get_event_listings: 1
});

export function emptyLedger() {
  return { version: 1, remaining: null, blockedUntil: 0, days: {}, endpoints: {} };
}

function validCredits(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createBudgetedRequest({
  ledger, policy, persist, transport, now = Date.now, trustHeaders = false
}) {
  if (ledger.version !== 1 || !ledger.days || !ledger.endpoints
    || !Object.entries(ledger.days).every(([day, amount]) =>
      /^\d{4}-\d{2}-\d{2}$/.test(day) && validCredits(amount))
    || !Object.values(ledger.endpoints).every(usage => usage
      && ['estimated', 'actual', 'accounted', 'unverified'].every(key => validCredits(usage[key])))
    || !validCredits(ledger.blockedUntil)
    || (ledger.remaining !== null && !validCredits(ledger.remaining))
    || !['initial', 'daily', 'monthly', 'reserve'].every(key => validCredits(policy[key]))) {
    throw new Error('Invalid TicketSwap credit configuration');
  }

  let queue = Promise.resolve();
  let storageFailed = false;
  const pending = new Map();
  const cache = new Map();

  async function save() {
    try {
      await persist(ledger);
    } catch {
      storageFailed = true;
      throw new Error('Could not save TicketSwap credit usage');
    }
  }

  async function run(endpoint, params, key, cost) {
    const timestamp = now();
    const saved = cache.get(key);
    if (saved && timestamp < saved.expiresAt) return saved.value;
    cache.delete(key);
    if (storageFailed) throw new Error('TicketSwap credit storage unavailable');
    if (timestamp < ledger.blockedUntil) throw new Error('TicketSwap checks temporarily paused');

    const date = new Date(timestamp).toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    const monthUsed = Object.entries(ledger.days)
      .filter(([day]) => day.startsWith(month))
      .reduce((total, [, spend]) => total + spend, 0);
    const remaining = ledger.remaining ?? policy.initial;
    if ((ledger.days[date] ?? 0) + cost > policy.daily
      || monthUsed + cost > policy.monthly || remaining - cost < policy.reserve) {
      throw new Error('TicketSwap credit budget exhausted');
    }

    // Persist the conservative debit before issuing a request. An interrupted
    // run consumes its estimate even if the final charge is unavailable.
    ledger.remaining = remaining - cost;
    ledger.days[date] = (ledger.days[date] ?? 0) + cost;
    const usage = ledger.endpoints[endpoint] ??= {
      estimated: 0, actual: 0, accounted: 0, unverified: 0
    };
    usage.estimated += cost;
    usage.accounted += cost;
    usage.unverified += 1;
    await save();

    let feedback;
    let value;
    let failure;
    try {
      value = await transport(endpoint, params, response => { feedback = response; });
    } catch (error) {
      failure = error;
    }

    const charged = trustHeaders && validCredits(feedback?.charged) ? feedback.charged : null;
    if (charged !== null) {
      usage.actual += charged;
      usage.unverified -= 1;
      usage.accounted += charged - cost;
      ledger.days[date] += charged - cost;
      ledger.remaining = Math.max(0, remaining - charged);
    }
    if (trustHeaders && validCredits(feedback?.remaining)) {
      // Explicit funding changes require an operator reconciliation.
      ledger.remaining = Math.min(ledger.remaining, feedback.remaining);
    }
    if (feedback?.status === 402) ledger.remaining = 0;
    if (failure) {
      const delay = Math.min(3600000, Math.max(60000, feedback?.retryAfterMs || 0));
      ledger.blockedUntil = now() + delay;
    }
    if (failure || charged !== null || (trustHeaders && validCredits(feedback?.remaining))) {
      await save();
    }
    if (failure) throw failure;

    cache.set(key, { value, expiresAt: now() + 5 * 60000 });
    return value;
  }

  return function request(endpoint, params) {
    if (!Object.hasOwn(endpointCosts, endpoint)) {
      return Promise.reject(new Error('Unsupported TicketSwap endpoint'));
    }
    const key = JSON.stringify([endpoint, Object.entries(params).sort(([a], [b]) => a.localeCompare(b))]);
    if (pending.has(key)) return pending.get(key);
    const operation = queue.then(() => run(endpoint, params, key, endpointCosts[endpoint]))
      .finally(() => pending.delete(key));
    pending.set(key, operation);
    queue = operation.catch(() => {});
    return operation;
  };
}
