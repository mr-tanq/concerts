// Shared event identity for search, persistence and scheduled discovery.
export const searchKey = value => String(value || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function sameSearchConcert(a, b) {
  if ((a.id && a.id === b.id) || (a.recommendationId && a.recommendationId === b.id) || (b.recommendationId && b.recommendationId === a.id)) return true;
  if (a.source && a.source === b.source && a.sourceId && b.sourceId) return String(a.sourceId) === String(b.sourceId);
  if (a.date !== b.date || !a.date) return false;
  // Compare across sources without collapsing two venues in the same city.
  const names = c => [c.artist, ...(c.lineup || []), ...(c.supportingArtists || [])].map(searchKey).filter(Boolean);
  if (!names(a).some(n => names(b).includes(n))) return false;
  const venue = c => searchKey(c.venue).replace(/^tivoli vredenburg\b/, 'tivolivredenburg');
  return !!venue(a) && venue(a) === venue(b) && (!a.city || !b.city || searchKey(a.city) === searchKey(b.city));
}
export function concertSearchState(c, { recommendations = [], planned = [], dismissed = [], archived = [], dismissedIds = [], plannedIds = [] }) {
  if (planned.some(x => sameSearchConcert(c, x)) || plannedIds.includes(c.id)) return 'Already in Going';
  if (dismissed.some(x => sameSearchConcert(c, x)) || dismissedIds.includes(c.id)) return 'In Set aside';
  if (archived.some(x => sameSearchConcert(c, x))) return 'Already in Archive';
  if (recommendations.some(x => sameSearchConcert(c, x))) return 'Already in Deciding';
  return null;
}
export function preserveManualConcerts(generated, previous, { today, history, archive = [] }) {
  const kept = [...generated];
  for (const c of previous) {
    if (!c.manualSearch || c.date < today) continue;
    if (concertSearchState(c, { plannedIds: history.plannedIds || [], dismissedIds: history.dismissedIds || [], dismissed: history.dismissed || [], archived: archive })) continue;
    const index = kept.findIndex(x => sameSearchConcert(c, x));
    if (index >= 0) kept[index] = { ...kept[index], id: c.id, manualSearch: c.manualSearch, match: c.match, discoveredAt: c.discoveredAt };
    else kept.push(c);
  }
  return kept;
}
export function validateSearchRequest(value) {
  if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id || '')) throw new Error('Invalid search id');
  const artist = String(value.artist || '').trim(), place = String(value.place || '').trim();
  if (artist.length < 2 || artist.length > 100 || searchKey(artist).length < 2 ||
    (place && (place.length < 2 || place.length > 120 || searchKey(place).length < 2)) ||
    /[\r\n\x00-\x1f]/.test(artist + place)) throw new Error('Enter an artist; venue or city is optional');
  return { id: value.id, artist, place };
}
