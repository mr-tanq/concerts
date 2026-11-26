import robotsParser from 'robots-parser';

const agent = 'ListeningMirrorTickets';
export class PublisherBackoff extends Error {
  constructor(retryAt) {
    super('Official publisher access unavailable');
    this.retryAt = retryAt;
  }
}

const MANUAL_REDIRECTS = [301, 302, 303, 307, 308];

export function createOfficialPageReader({ fetcher = fetch, now = Date.now } = {}) {
  const pages = new Map();
  const policies = new Map();
  const blocked = new Map();

  async function fetchText(url, mediaType, maximum) {
    const response = await fetcher(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': `${agent}/1.0 (+https://github.com/mr-tanq/concerts)`,
        'Accept': mediaType,
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
      throw new PublisherBackoff(retryAt);
    }
    if (response.status !== 200 || !response.body
      || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mediaType
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
      policies.set(origin, fetchText(robotsURL, 'text/plain', 512000)
        .then(result => {
          if (result.status === 404) return () => true;
          if (result.status !== 200) return () => false;
          const policy = robotsParser(robotsURL, result.text);
          return target => policy.isAllowed(target, agent) === true;
        }).catch(error => {
          if (error instanceof PublisherBackoff) throw error;
          return () => false;
        }));
    }
    return policies.get(origin).then(allowed => allowed(url));
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
      if (!await robotsAllowed(url)) throw new Error('Publisher robots policy does not permit this check');
      const maximum = source.domain === 'effenaar.nl' ? 8_000_000 : 3_000_000;
      const page = await fetchText(url, 'text/html', maximum);
      if (page.status === 200) return { html: page.text, url, observedAt: now() };
      if (!MANUAL_REDIRECTS.includes(page.status) || !page.location) break;
      const next = new URL(page.location, url);
      next.hash = '';
      next.search = '';
      url = next.href;
    }
    throw new Error('Official publisher page unavailable');
  }

  return source => {
    if (!pages.has(source.url)) pages.set(source.url, read(source));
    return pages.get(source.url);
  };
}
