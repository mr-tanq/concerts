import { cleanTicketURL } from '../../js/ticket-links.js';
import robotsParser from 'robots-parser';

const agent = 'ListeningMirrorTickets';
export class PublisherBackoff extends Error {
  constructor(retryAt, reason = 'rate-limited') {
    super('Official publisher access unavailable');
    this.retryAt = retryAt;
    // 'access-control' (an anti-bot challenge or 401/403) or 'rate-limited' (429).
    this.reason = reason;
  }
}

export class RobotsDisallowed extends Error {
  constructor(url) {
    super('Publisher robots policy does not permit this check');
    this.url = url;
  }
}

const MANUAL_REDIRECTS = [301, 302, 303, 307, 308];

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// `delayMs` spaces requests to one host (Podiuminfo and Festivalinfo ask for
// Crawl-delay: 1). Injected fetchers in tests default to no delay.
export function createOfficialPageReader({
  fetcher = fetch, now = Date.now, sleep = pause, delayMs = fetcher === fetch ? 1100 : 0
} = {}) {
  const pages = new Map();
  const policies = new Map();
  const blocked = new Map();
  const lastRequest = new Map();
  let requests = 0;

  async function paced(url) {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const wait = (lastRequest.get(hostname) ?? -Infinity) + delayMs - now();
    if (wait > 0) await sleep(wait);
    lastRequest.set(hostname, now());
    requests++;
  }

  async function fetchText(url, mediaType, maximum) {
    await paced(url);
    const types = Array.isArray(mediaType) ? mediaType : [mediaType];
    const response = await fetcher(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': `${agent}/1.0 (+https://github.com/mr-tanq/concerts)`,
        'Accept': types.join(','),
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8'
      }
    });
    if (MANUAL_REDIRECTS.includes(response.status) || response.status === 404) {
      await response.body?.cancel();
      return { status: response.status, location: response.headers.get('location') };
    }
    if ([401, 403, 429].includes(response.status)) {
      const retry = response.headers.get('retry-after');
      const instant = /^\d{1,10}$/.test(retry ?? '') ? now() + Number(retry) * 1000 : Date.parse(retry);
      const retryAt = Math.max(now() + 3600000, Number.isFinite(instant) ? instant : 0);
      blocked.set(new URL(url).hostname.replace(/^www\./, ''), retryAt);
      await response.body?.cancel();
      // Challenges and 401/403 are access controls: back off, never retry around them.
      throw new PublisherBackoff(retryAt, response.status === 429 ? 'rate-limited' : 'access-control');
    }
    if (response.status !== 200 || !response.body
      || !types.includes(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase())
      || Number(response.headers.get('content-length')) > maximum) {
      await response.body?.cancel();
      throw new Error('Official publisher response unavailable');
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maximum) throw new Error('Official publisher response too large');
      chunks.push(Buffer.from(chunk));
    }
    return { status: response.status, text: Buffer.concat(chunks).toString('utf8') };
  }

  function robotsAllowed(url) {
    const origin = new URL(url).origin;
    if (!policies.has(origin)) {
      const robotsURL = origin + '/robots.txt';
      // RFC 9309: follow a few redirects (013.nl → www.013.nl); the rules found
      // there apply to the requested origin.
      const load = async () => {
        let current = robotsURL;
        for (let hop = 0; hop < 5; hop++) {
          const result = await fetchText(current, 'text/plain', 512000);
          if (!MANUAL_REDIRECTS.includes(result.status)) return result;
          if (!result.location) break;
          const next = new URL(result.location, current);
          if (next.protocol !== 'https:' || next.pathname !== '/robots.txt') break;
          current = next.href;
        }
        return { status: 0 };
      };
      policies.set(origin, load()
        .then(result => {
          if (result.status === 404) return () => true;
          if (result.status !== 200) return () => false;
          const policy = robotsParser(robotsURL, result.text);
          return target => policy.isAllowed(target, agent) === true;
        }).catch(error => {
          if (error instanceof PublisherBackoff) throw error;
          // A robots.txt that cannot be read (network failure, oversized or
          // malformed response) permits nothing, but it is reported as an
          // unreachable source, not as the publisher's policy. The failure
          // is not cached, so a later concert may retry it.
          policies.delete(origin);
          return null;
        }));
    }
    return policies.get(origin).then(allowed => {
      if (!allowed) throw new Error('Official publisher robots.txt unreachable');
      return allowed(url);
    });
  }

  async function read(source) {
    let url = source.url;
    for (let hop = 0; hop < 3; hop++) {
      const target = new URL(url);
      if (blocked.has(source.domain)) throw new PublisherBackoff(blocked.get(source.domain));
      if (target.protocol !== 'https:' || target.username || target.password || target.port
        || target.hostname.replace(/^www\./, '') !== source.domain) {
        throw new Error('Official publisher access unavailable');
      }
      if (!await robotsAllowed(url)) throw new RobotsDisallowed(url);
      const maximum = source.domain === 'effenaar.nl' ? 8_000_000 : 3_000_000;
      const page = await fetchText(url, source.mediaType === 'application/json' ? 'application/json' : 'text/html', maximum);
      if (page.status === 200) return { html: page.text, url, observedAt: now() };
      if (!MANUAL_REDIRECTS.includes(page.status) || !page.location) break;
      const next = new URL(page.location, url);
      next.hash = '';
      url = cleanTicketURL(next.href);
      if (!url) break;
    }
    throw new Error('Official publisher page unavailable');
  }

  const readPage = source => {
    if (!pages.has(source.url)) pages.set(source.url, read(source));
    return pages.get(source.url);
  };

  // The `fetcher(url, hosts)` contract of concert schedule discovery, with the
  // same robots, pacing, size and access-control rules. Redirects stay on the
  // approved hosts; listings and sitemaps may be XML, Ziggo's agenda is JSON.
  const discoveryPages = new Map();
  async function discover(url, hosts) {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      const target = new URL(current);
      const hostname = target.hostname.replace(/^www\./, '');
      if (target.protocol !== 'https:' || target.username || target.password || target.port
        || !hosts.includes(hostname)) throw new Error('Unapproved source host');
      if (blocked.has(hostname)) throw new PublisherBackoff(blocked.get(hostname), 'access-control');
      if (!await robotsAllowed(current)) throw new RobotsDisallowed(current);
      const page = await fetchText(current, ['text/html', 'application/xml', 'text/xml', 'application/json'],
        hostname === 'effenaar.nl' ? 8_000_000 : 3_000_000);
      if (page.status === 200) return { html: page.text, url: current, observedAt: now() };
      if (!MANUAL_REDIRECTS.includes(page.status) || !page.location) break;
      current = cleanTicketURL(page.location, current);
      if (!current) break;
    }
    throw new Error('Official publisher page unavailable');
  }
  readPage.fetchPage = (url, hosts) => {
    const key = url + '\n' + hosts.join(',');
    if (!discoveryPages.has(key)) discoveryPages.set(key, discover(url, hosts));
    return discoveryPages.get(key);
  };
  readPage.robotsAllowed = robotsAllowed;
  readPage.requestCount = () => requests;
  return readPage;
}
