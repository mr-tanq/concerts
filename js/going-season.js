// Presentation data only: no writes, inferred set times, or attendance claims.
const key = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function seasonSummary(concerts, shiftFor) {
  const months = new Map();
  let booked = 0, work = 0, arranged = 0;
  for (const c of concerts) {
    const shift = shiftFor(c.date);
    const conflict = /evening|night/.test(shift?.label || '');
    const sorted = conflict && c.workArrangement?.kind === 'freeDay' && c.workArrangement?.status === 'yes';
    const ticket = c.practical?.ticketBought === true;
    booked += Number(ticket); work += Number(conflict); arranged += Number(sorted);
    const month = String(c.date).slice(0, 7);
    if (!months.has(month)) months.set(month, { month, booked: 0, planned: 0, work: 0, total: 0 });
    const row = months.get(month);
    row.total++;
    // Mutually exclusive segments; ticket ownership does not imply time off.
    row[ticket ? 'booked' : conflict && !sorted ? 'work' : 'planned']++;
  }
  return { shows: concerts.length, nights: new Set(concerts.map(c => c.date)).size,
    booked, work, arranged, months: [...months.values()].sort((a,b) => a.month.localeCompare(b.month)) };
}

export function listeningWindow(data, today, size = 8) {
  const weeks = [...new Set(data?.meta?.weekStarts || [])].filter(w => /^\d{4}-\d{2}-\d{2}$/.test(w) && w <= today).sort().slice(-size);
  if (!weeks.length) return null;
  const artists = new Map(Object.entries(data.artists || {}).map(([name, record]) => [key(record.name || name), record]));
  return { weeks, updatedAt: data.meta.lastUpdated,
    plays(name) { return weeks.reduce((n, week) => n + Math.max(0, Number(artists.get(key(name))?.weeks?.[week]) || 0), 0); } };
}
