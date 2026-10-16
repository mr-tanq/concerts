function count(value, field) {
  if (!(typeof value === 'number'
    || (typeof value === 'string' && /^\d+$/.test(value)))) {
    throw new Error(`Invalid Last.fm ${field}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Invalid Last.fm ${field}`);
  }
  return number;
}

export function readIdentityProfile(info, username, previous = null) {
  const user = info?.user;
  if (!user || typeof user.name !== 'string'
    || user.name.toLowerCase() !== String(username).toLowerCase()) {
    throw new Error('Last.fm profile is missing or belongs to another user');
  }

  const totalScrobbles = count(user.playcount, 'playcount');
  const sameUser =
    String(previous?.meta?.lastfmUser || '').toLowerCase()
    === String(username).toLowerCase();

  if (sameUser && previous?.profile?.totalScrobbles > 0
    && totalScrobbles === 0) {
    throw new Error('Last.fm returned zero after a positive total; previous snapshot kept');
  }

  const registered = count(user.registered?.unixtime, 'registration date');
  const date = new Date(registered * 1000);
  if (registered === 0 || !Number.isFinite(date.getTime())) {
    throw new Error('Invalid Last.fm registration date');
  }

  return {
    totalScrobbles,
    registeredAt: date.toISOString(),
    url: `https://www.last.fm/user/${encodeURIComponent(username)}`
  };
}
