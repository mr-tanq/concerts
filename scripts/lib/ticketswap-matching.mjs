// General matching rules. No artist-specific exceptions.
export const words = value => String(value ?? '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean);

const key = value => words(value).join('');

const blocked = title =>
  /\b(?:upgrade|parking|tribute|afterparty|after\s+party|locker|shuttle)\b|ticket\s+not\s+included|\b(?:vip|hospitality)\s+package\b/i
    .test(title || '');

export function ticketSwapURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:'
      && !u.username && !u.password
      && ['ticketswap.com', 'www.ticketswap.com'].includes(u.hostname)
      ? u.href : null;
  } catch {
    return null;
  }
}

function artistScore(concert, title) {
  if (blocked(title)) return 0;
  if (key(title) === key(concert.artist)) return 100;

  const target = words(concert.artist);
  const actual = words(title);
  if (!target.length) return 0;

  let position = -1;
  for (let i = 0; i <= actual.length - target.length; i++) {
    if (target.every((word, j) => actual[i + j] === word)) {
      position = i;
      break;
    }
  }

  // Require the complete artist name, never a substring.
  if (position < 0) return 0;
  // A separately billed artist may appear anywhere in a shared lineup.
  const billed = String(title).split(/\s*\+\s*|\s+[&/]\s+/);
  if (billed.length > 1 && billed.some(part =>
    words(part).join(' ') === target.join(' ')
  )) return 92;

  if (position > 0) return 60;

  const tail = actual.slice(target.length);
  const descriptors = [
    'tour', 'anniversary', 'live', 'concert', 'show',
    'presents', 'with', 'feat', 'featuring', 'support'
  ];

  if (tail.some(word => descriptors.includes(word))) return 92;
  if (/[+&/]/.test(String(title))) return 92;

  const support = (concert.supportingArtists || []).map(key);
  if (support.some(name =>
    name && key(tail.join(' ')) === name
  )) return 92;

  return 65;
}

function venueCore(value) {
  const result = words(value);
  const prefixes = new Set([
    'the', 'de', 'het', 'poppodium', 'podium', 'club', 'klub'
  ]);

  // Preserve room names and numbers.
  while (result.length > 1 && prefixes.has(result[0])) {
    result.shift();
  }
  return result;
}

function venueScore(a, b) {
  if (!key(a) || !key(b)) return 0;
  if (key(a) === key(b)) return 100;

  const x = venueCore(a);
  const y = venueCore(b);
  if (x.join('') === y.join('')) return 95;

  const shorter = x.length < y.length ? x : y;
  const longer = x.length < y.length ? y : x;

  if (!shorter.every((word, i) => longer[i] === word)) return 0;

  // Extended venue names are usable only without room or stage qualifiers.
  const extra = longer.slice(shorter.length);
  const room = /^(?:room|rooms|zaal|zalen|hall|halls|stage|stages|main|small|large|grote|groot|kleine|klein|boven|beneden|upstairs|downstairs|studio|club|theater|theatre|auditorium|rabo|pandora|second|secondary|annex|annexe|[0-9]+|[ivx]+)$/;
  const generic = new Set([
    'arena', 'hall', 'club', 'theater', 'theatre',
    'stadium', 'poppodium', 'podium', 'venue'
  ]);
  const distinctive = shorter.some(word =>
    word.length >= 5 && !generic.has(word) && !/^\d+$/.test(word)
  );
  return distinctive && !extra.some(word => room.test(word)) ? 90 : 60;
}

export function resolveTicketSwap(concert, results, pageInfo = {}) {
  if (!Array.isArray(results)) {
    throw new Error('Unexpected search response');
  }

  const unique = new Map();
  for (const event of results) {
    if (event?.__typename !== 'EventResult'
      || !event.id
      || !ticketSwapURL(event.uri?.url)) continue;

    if (!unique.has(event.id)) unique.set(event.id, event);
  }

  const candidates = [];

  for (const event of unique.values()) {
    if (event.startDate?.slice(0, 10) !== concert.date) continue;
    if (blocked(event.name)) continue;

    if (event.country?.code
      && key(event.country.code) !== key(concert.country)) continue;

    const artist = artistScore(concert, event.name);
    const venue = venueScore(concert.venue, event.locationName);
    const city = !!key(concert.city)
      && key(concert.city) === key(event.cityName);
    const country = !!event.country?.code
      && key(concert.country) === key(event.country.code);

    if (!artist || (!venue && !city)) continue;

    candidates.push({
      event,
      score: artist * .45 + venue * .4 + (city ? 15 : 0),
      strong: artist >= 90 && venue >= 90 && city && country
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const strong = candidates.filter(candidate => candidate.strong);
  const best = strong[0];

  const closeAlternative = best && candidates.some(candidate =>
    candidate.event.id !== best.event.id
    && candidate.score >= best.score - 10
  );

  if (strong.length === 1 && !closeAlternative) {
    return { status: 'matched', event: best.event, candidates };
  }

  return {
    status: candidates.length
      ? 'needs-review'
      : pageInfo.hasNextPage === true
        ? 'search-incomplete'
        : 'not-found',
    candidates
  };
}

export function reviewCandidates(resolution) {
  return resolution.candidates.slice(0, 5).map(({ event, score }) => ({
    id: event.id,
    name: event.name,
    date: event.startDate?.slice(0, 10),
    venue: event.locationName,
    city: event.cityName,
    country: event.country?.code,
    url: ticketSwapURL(event.uri?.url),
    score: Math.round(score)
  }));
}
