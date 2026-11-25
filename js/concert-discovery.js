const key = s => String(s || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g,'').toLowerCase()
  .replace(/\s+/g,' ').trim();

const safeURL = value => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
};

export function supportChoices(concerts, today, counts = {}) {
  const limit = new Date(`${today}T12:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 60);
  const until = limit.toISOString().slice(0,10);
  const seen = new Set(), choices = [];

  for (const c of [...concerts].sort((a,b) =>
    String(a.date).localeCompare(String(b.date)))) {
    if (!c.date || c.date < today || c.date > until) continue;
    const schedule = c.schedule?.date === c.date ? c.schedule : null;
    if (schedule?.noSupport) continue;

    const names = [
      ...(c.supportingArtists || []),
      ...(schedule?.support || []).map(s => s.name)
    ];
    for (const name of names) {
      const k = key(name);
      if (!k ||
          /^(support|support act|voorprogramma|tba|special guest|unknown)$/.test(k) ||
          k === key(c.artist) || seen.has(k)) continue;
      seen.add(k);
      choices.push({concert:c, name, plays:Number(counts[k]) || 0});
    }
  }
  return choices.sort((a,b) =>
    a.plays - b.plays || a.concert.date.localeCompare(b.concert.date));
}

export function shareText(c, dateLabel) {
  const link = safeURL(c.sourceUrl) || safeURL(c.ticketUrl);
  return [
    `Πάω στους ${c.artist}!`,
    `${dateLabel} · ${c.venue || ''}${c.city ? ' · '+c.city : ''}`,
    'Ψήνεσαι να έρθεις;',
    link
  ].filter(Boolean).join('\n');
}

export function shareConcertButton(c, dateLabel, label = 'Share concert') {
  const wrap = document.createElement('div');
  wrap.className = 'concert-share';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'plain-act';
  button.textContent = label;
  const status = document.createElement('p');
  status.className = 'footnote';
  status.setAttribute('role','status');
  wrap.append(button, status);

  button.addEventListener('click', async () => {
    const text = shareText(c, dateLabel);
    status.textContent = '';
    try {
      if (navigator.share) {
        await navigator.share({title:c.artist, text});
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        status.textContent = 'Copied — paste it into your message.';
        return;
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
    }

    let field = wrap.querySelector('textarea');
    if (!field) {
      field = document.createElement('textarea');
      field.readOnly = true;
      field.setAttribute('aria-label','Concert invitation to copy');
      field.style.cssText =
        'width:100%;min-height:120px;background:transparent;color:inherit;font:inherit';
      wrap.append(field);
    }
    field.value = text;
    field.focus();
    field.select();
    status.textContent = 'Copy this invitation into your message.';
  });
  return wrap;
}

// "Before the headliner": the opening acts of your next nights, as a row of
// poster cards you swipe through — photo full-bleed, the name large, why it
// matters ("Opening for Terror") and two actions: listen, or open the night.
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function whenLabel(date, today) {
  const d = new Date(`${date}T12:00:00Z`), t = new Date(`${today}T12:00:00Z`);
  const days = Math.round((d - t) / 86400000);
  const rel = days <= 0 ? 'Tonight' : days === 1 ? 'Tomorrow' : days < 14 ? `In ${days} days` : `In ${Math.round(days / 7)} weeks`;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${rel}`;
}

export function mountSupportDiscovery(host, {
  concerts, today, counts, imageFor, openConcert
}) {
  const choices = supportChoices(concerts, today, counts);
  const el = (tag, className, textValue) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (textValue != null) n.textContent = textValue;
    return n;
  };
  const verifiedPhotos = {
    barrens: new URL("../assets/artists/barrens.jpg", import.meta.url).href
  };
  const photoFor = name => {
    const url = verifiedPhotos[key(name)] || safeURL(imageFor({artist:name}));
    return url && !/e23066163f21176a822b54001ee648a2|placeholder|default[-_]artist|no[-_]image/i.test(url) ? url : null;
  };

  host.replaceChildren();
  host.className = 'support-discovery';
  host.parentElement?.classList.add('caughtup-discovery');
  host.append(el('p', 'discovery-status', 'All caught up. Nothing new to decide.'));

  if (!choices.length) {
    host.append(
      el('h2', 'discovery-quiet', 'Quiet for now.'),
      el('p', 'footnote', 'Your plans are waiting in Going.')
    );
    return;
  }

  const head = el('div', 'discovery-head');
  const counter = el('p', 'discovery-count', choices.length > 1 ? `1 / ${choices.length}` : '');
  head.append(el('p', 'whisper', 'Before the headliner'), counter);
  host.append(head);

  const rail = el('div', 'discovery-rail');
  rail.setAttribute('role', 'list');
  choices.forEach(({concert:c, name}, i) => {
    const card = el('article', 'discovery-card');
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', `${name}, opening for ${c.artist}`);
    const photo = el('div', 'discovery-photo');
    const url = photoFor(name);
    if (url) {
      // Load quietly; a dead link leaves the typographic card, never a broken image.
      const probe = new Image();
      probe.onload = () => { photo.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`; card.classList.add('has-photo'); };
      probe.src = url;
    }
    const copy = el('div', 'discovery-copy');
    copy.append(
      el('p', 'discovery-when', whenLabel(c.date, today)),
      el('h2', 'discovery-name', name),
    );
    const forLine = el('p', 'discovery-for', 'Opening for ');
    forLine.append(el('b', '', c.artist));
    copy.append(forLine, el('p', 'discovery-place', [c.venue, c.city].filter(Boolean).join(', ')));

    const actions = el('div', 'discovery-actions');
    const listen = el('a', 'discovery-listen', 'Listen ↗');
    listen.href = 'https://open.spotify.com/search/' + encodeURIComponent(name);
    listen.target = '_blank';
    listen.rel = 'noopener noreferrer';
    const night = el('button', 'discovery-night', 'The night →');
    night.type = 'button';
    night.addEventListener('click', () => openConcert(c));
    actions.append(listen, night);
    copy.append(actions);

    card.append(photo, el('div', 'discovery-veil'), copy);
    rail.append(card);
    if (i === 0) card.classList.add('is-current');
  });
  host.append(rail);

  // Keep "2 / 5" in step with the swipe.
  if (choices.length > 1) {
    let raf = 0;
    rail.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const cards = [...rail.children];
        const mid = rail.scrollLeft + rail.clientWidth / 2;
        let current = 0, best = Infinity;
        cards.forEach((card, i) => {
          const d = Math.abs(card.offsetLeft + card.offsetWidth / 2 - mid);
          if (d < best) { best = d; current = i; }
        });
        counter.textContent = `${current + 1} / ${cards.length}`;
        cards.forEach((card, i) => card.classList.toggle('is-current', i === current));
      });
    }, { passive: true });
  }
}
