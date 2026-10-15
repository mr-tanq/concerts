import { summarizeListings } from './ticketswap-summary.mjs';

const norm = value => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]/gu, '');

export const identity = c => JSON.stringify([
  c.artist, c.date, c.venue, c.city, c.country
]);

export function selectConcerts(concerts, entries, now = new Date(), limit = 3) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  return concerts.filter(c => {
    if (c.practical?.ticketBought === true || c.date < today) return false;

    if (![c.id, c.artist, c.date, c.venue, c.city, c.country]
      .every(v => typeof v === 'string' && v.trim())) return false;

    const old = entries[c.id];
    const age = now.getTime() - Date.parse(old?.lastAttemptAt);

    return old?.identity !== identity(c)
      || !Number.isFinite(age)
      || age >= 6 * 3600000;
  })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);
}

function matchesArtist(concert, title) {
  const raw = String(title || '');

  if (/\b(?:upgrade|parking|tribute|afterparty)\b|ticket\s+not\s+included|\bvip\s+package\b/i.test(raw)) {
    return false;
  }

  const clean = value => String(value || '')
    .replace(
      /\s*[-–—:|]?\s*(?:(?:\d+(?:st|nd|rd|th)?\s+)?anniversary\s+tour|(?:world|european|europe|uk)\s+tour)\s*$/i,
      ''
    )
    .trim();

  if (norm(raw) === norm(concert.artist)
    || norm(clean(raw)) === norm(concert.artist)) {
    return true;
  }

  const names = clean(raw).split(/\s*\+\s*/).map(norm);
  const known = new Set([
    concert.artist,
    ...(concert.supportingArtists || [])
  ].map(norm));

  return names.length > 1
    && names[0] === norm(concert.artist)
    && names.every(name => name && known.has(name));
}

export function matchEvent(c, results) {
  if (!Array.isArray(results)) {
    throw new Error('Unexpected event search response');
  }

  const matches = results.filter(e =>
    e.__typename === 'EventResult'
    && matchesArtist(c, e.name)
    && e.startDate?.slice(0, 10) === c.date
    && norm(e.locationName) === norm(c.venue)
    && norm(e.cityName) === norm(c.city)
    && norm(e.country?.code) === norm(c.country)
  );

  if (matches.length > 1) throw new Error('Ambiguous event match');
  return matches[0] || null;
}

function safeURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:'
      && ['ticketswap.com', 'www.ticketswap.com'].includes(u.hostname)
      && !u.username && !u.password
      ? u.href : null;
  } catch {
    return null;
  }
}

export async function checkConcert(c, old, request, now = new Date()) {
  const stamp = now.toISOString();
  const same = old?.identity === identity(c);
  let event = same ? old.event : null;

  try {
    if (!event) {
      const search = await request('search_events', { query: c.artist });
      const found = matchEvent(c, search.results);

      if (!found) {
        return {
          identity: identity(c),
          status: 'not-found',
          searchDiagnostics: {
            query: c.artist,
            expected: {
              artist: c.artist,
              date: c.date,
              venue: c.venue,
              city: c.city,
              country: c.country
            },
            candidates: (search.results || [])
              .filter(e => e.__typename === 'EventResult')
              .slice(0, 30)
              .map(e => ({
                name: e.name,
                date: e.startDate,
                venue: e.locationName,
                city: e.cityName,
                country: e.country?.code,
                url: safeURL(e.uri?.url)
              })),
            pageInfo: search.page_info || null
          },
          lastAttemptAt: stamp,
          checkedAt: stamp
        };
      }

      const url = safeURL(found.uri?.url);
      if (!found.id || !url) throw new Error('Invalid event');

      event = {
        id: found.id,
        url,
        name: found.name,
        date: c.date
      };
    }

    const data = await request('get_event_listings', {
      event_id: event.id,
      listing_status: 'AVAILABLE',
      currency: 'EUR',
      limit: 30
    });

    if (data.event_id !== event.id) throw new Error('Wrong event');

    return {
      identity: identity(c),
      event,
      status: 'ok',
      ...summarizeListings(data),
      checkedAt: stamp,
      lastAttemptAt: stamp,
      lastError: null
    };
  } catch {
    return {
      ...(same ? old : {}),
      identity: identity(c),
      ...(event ? { event } : {}),
      status: 'error',
      lastAttemptAt: stamp,
      lastError: 'TicketSwap check failed'
    };
  }
}
