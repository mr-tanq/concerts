const normalize = name => name.toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

export function collectArtistImageNames(collections) {
  const names = new Map();
  const note = name => {
    if (typeof name !== 'string') return;
    const key = normalize(name);
    if (!key || /^(support|support act|voorprogramma|tba|unknown|special guest)$/.test(key)) return;
    if (!names.has(key)) names.set(key, name.trim());
  };
  for (const list of collections) for (const c of list || []) {
    note(c.artist);
    for (const name of c.lineup || []) note(name);
    for (const name of c.supportingArtists || []) note(name);
    if (c.schedule?.date && c.schedule.date === c.date && !c.schedule.noSupport) {
      for (const act of c.schedule.support || []) note(act?.name);
    }
  }
  return names;
}

export function usableArtistPhoto(value) {
  if (typeof value !== 'string' || /e23066163f21176a822b54001ee648a2|placeholder|default[-_]artist|no[-_]image/i.test(value)) return null;
  try { return new URL(value).protocol === 'https:' ? value : null; }
  catch { return null; }
}
