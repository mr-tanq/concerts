const identity = c => JSON.stringify([
  c.artist, c.date, c.venue, c.city, c.country
]);

export function selectRequestedConcerts(
  concerts, entries, requests, now = new Date()
) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  return concerts.filter(c => {
    const q = requests[c.id];

    return q
      && typeof q.requestId === 'string'
      && /^[a-f0-9-]{36}$/i.test(q.requestId)
      && q.identity === identity(c)
      && Number.isFinite(Date.parse(q.requestedAt))
      && entries[c.id]?.requestId !== q.requestId
      && c.date >= today
      && [c.id, c.artist, c.date, c.venue, c.city, c.country]
        .every(v => typeof v === 'string' && v.trim());
  })
    .sort((a, b) =>
      requests[a.id].requestedAt.localeCompare(requests[b.id].requestedAt)
    )
    .slice(0, 3);
}
