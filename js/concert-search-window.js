// Shared horizon for automatic discovery and searches requested in the app.
export function concertSearchEnd(startDate, discovery = {}) {
  const start = new Date(`${startDate}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(start.getTime()) || start.toISOString().slice(0,10) !== startDate) throw new Error('Invalid search start date');
  if (discovery.lookaheadMonths === undefined && Number.isInteger(discovery.lookaheadDays) && discovery.lookaheadDays > 0) {
    start.setUTCDate(start.getUTCDate() + discovery.lookaheadDays);
    return start.toISOString().slice(0,10);
  }
  const months = discovery.lookaheadMonths ?? 18;
  if (!Number.isInteger(months) || months < 1 || months > 36) throw new Error('Invalid discovery horizon');
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth()+1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return start.toISOString().slice(0,10);
}
