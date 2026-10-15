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

export function mountSupportDiscovery(host, {
  concerts, today, counts, imageFor, formatDate, openConcert
}) {
  const choices = supportChoices(concerts, today, counts);
  let index = 0;
  const text = (tag, value, className) => {
    const n = document.createElement(tag);
    n.textContent = value;
    if (className) n.className = className;
    return n;
  };

  function render() {
    host.replaceChildren();
    host.className = 'support-discovery';
    host.append(text('p','ALL CAUGHT UP','whisper'));

    if (!choices.length) {
      host.append(
        text('h2','Quiet for now.','entry-artist'),
        text('p',
          'No new concerts to decide on. Your plans are waiting in Going.',
          'lede')
      );
      return;
    }

    const {concert:c, name} = choices[index];
    host.append(text('p','BEFORE THE HEADLINER','whisper'));

    const url = safeURL(imageFor({artist:name}));
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = name;
      img.style.cssText =
        'width:100%;max-height:320px;object-fit:cover;margin:16px 0';
      img.addEventListener('error', () => img.remove(), {once:true});
      host.append(img);
    }

    host.append(
      text('h2',name,'entry-artist'),
      text('p',`Opening for ${c.artist}`,'lede'),
      text('p',`${formatDate(c.date)} · ${c.venue} · ${c.city}`,'footnote'),
      text('p','Get to know the opening act before your night out.','footnote')
    );

    const actions = document.createElement('div');
    actions.className = 'act-row';
    actions.style.paddingLeft = '0';

    const listen = document.createElement('a');
    listen.className = 'plain-act';
    listen.textContent = 'Listen ↗';
    listen.href = 'https://open.spotify.com/search/' + encodeURIComponent(name);
    listen.target = '_blank';
    listen.rel = 'noopener noreferrer';

    const details = text('button','View concert','plain-act');
    details.type = 'button';
    details.addEventListener('click', () => openConcert(c));
    actions.append(listen, details);
    host.append(actions);
    host.append(shareConcertButton(c, formatDate(c.date), 'Invite a friend'));

    if (choices.length > 1) {
      const next = text('button','Another opening act →','plain-act');
      next.type = 'button';
      next.addEventListener('click', () => {
        index = (index + 1) % choices.length;
        render();
        const heading = host.querySelector('h2');
        heading.tabIndex = -1;
        heading.focus({preventScroll:true});
      });
      host.append(next);
    }
  }
  render();
}
