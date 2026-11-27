import { formatTicketMoney as money, knownAmount, ticketHistory } from './ticket-intelligence-model.js';

const shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' });
const longDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
});

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function renderTicketHistory(host, evidence) {
  const head = element('div', null, 'ti-section-head');
  head.append(element('h2', 'Price history'));
  host.append(head);
  const plot = element('div');
  host.append(plot);
  host.addEventListener('ticket-chart-reset', () => plot.dispatchEvent(new Event('ticket-chart-reset')), { once: true });

  function render(category = '') {
    plot.replaceChildren();
    const series = ticketHistory(evidence, category);
    const plotted = series.flatMap(group => group.points
      .filter(point => knownAmount(point.cents)).map(point => ({ ...point, group })));
    if (!plotted.length) {
      plot.append(element('p', 'No dated prices have been recorded for this view. An explicit check can add an observation.', 'ti-empty'));
      return;
    }
    const dates = series.flatMap(group => group.points.map(point => Date.parse(point.at)));
    const first = Math.min(...dates);
    const last = Math.max(...dates);
    const low = Math.min(...plotted.map(point => point.cents));
    const high = Math.max(...plotted.map(point => point.cents));
    const margin = Math.max(150, (high - low) / 6);
    const rough = (high - low + 2 * margin) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const unit = [1, 2, 5, 10].find(value => value * magnitude >= rough) * magnitude;
    const min = Math.max(0, Math.floor((low - margin) / unit) * unit);
    const max = Math.ceil((high + margin) / unit) * unit;
    const x = at => first === last ? 0.5 : (Date.parse(at) - first) / (last - first);
    const y = cents => (max - cents) / (max - min);

    const legend = element('div', null, 'ti-chart-legend');
    for (const group of series) {
      if (group.points.some(point => knownAmount(point.cents))) {
        legend.append(element('span', group.label, 'ti-series-' + group.id));
      }
    }
    plot.append(legend);

    const figure = element('figure', null, 'ti-chart');
    const axis = element('div', null, 'ti-chart-axis');
    axis.append(element('span', money(Math.round(max))), element('span', money(Math.round(min))));
    const stage = element('div', null, 'ti-chart-stage');
    const canvas = element('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    stage.append(canvas);
    figure.append(axis, stage);
    const datesLabel = element('div', null, 'ti-chart-dates');
    datesLabel.append(element('span', shortDate.format(first)), element('span', first === last ? '' : shortDate.format(last)));
    figure.append(datesLabel);
    plot.append(figure);

    const controls = element('div', null, 'ti-chart-inspect');
    const label = element('label', 'Inspect an observation');
    const picker = element('select');
    label.append(picker);
    const readout = element('p');
    readout.setAttribute('aria-live', 'polite');
    controls.append(label, readout);
    plot.append(controls);

    function inspect(index) {
      const selected = plotted[index];
      picker.value = String(index);
      readout.textContent = `${selected.group.label} · ${money(selected.cents)} · ${longDate.format(Date.parse(selected.at))}${selected.sampled ? ' · partial sample' : ''}`;
      stage.querySelectorAll('button').forEach((button, i) => button.classList.toggle('ti-point-active', Number(index) === i));
    }
    for (const [i, point] of plotted.entries()) {
      const marker = element('button', null, 'ti-point ti-series-' + point.group.id);
      const text = `${point.group.label} · ${money(point.cents)} · ${longDate.format(Date.parse(point.at))}`;
      marker.type = 'button';
      marker.setAttribute('aria-label', text);
      marker.style.left = x(point.at) * 100 + '%';
      marker.style.top = y(point.cents) * 100 + '%';
      marker.addEventListener('click', () => inspect(i));
      marker.addEventListener('focus', () => inspect(i));
      stage.append(marker);
      picker.add(new Option(text, String(i)));
    }
    picker.addEventListener('change', () => inspect(Number(picker.value)));
    inspect(plotted.reduce((latest, point, index) => Date.parse(point.at) > Date.parse(plotted[latest].at) ? index : latest, 0));

    function paint() {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.strokeStyle = 'rgba(239,229,208,.14)';
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(0, i * (height - 1) / 3 + .5);
        ctx.lineTo(width, i * (height - 1) / 3 + .5);
        ctx.stroke();
      }
      for (const group of series) {
        ctx.beginPath();
        ctx.strokeStyle = group.id === 'official' ? '#a8aeba' : group.id === 'official-listed' ? '#8a93a3' : '#dbc391';
        ctx.setLineDash(group.id === 'official-listed' ? [5, 4] : []);
        ctx.lineWidth = 2;
        let active = false;
        for (const point of group.points) {
          if (!knownAmount(point.cents)) { active = false; continue; }
          const coords = [x(point.at) * width, y(point.cents) * height];
          if (active) ctx.lineTo(...coords);
          else ctx.moveTo(...coords);
          active = true;
        }
        ctx.stroke();
      }
    }
    // Canvas is repainted on viewport changes and disconnected with its plot.
    const observer = new ResizeObserver(paint);
    observer.observe(stage);
    plot.addEventListener('ticket-chart-reset', () => observer.disconnect(), { once: true });
    host.closest('dialog')?.addEventListener('close', () => observer.disconnect(), { once: true });

    plot.append(element('p', `${money(low)}–${money(high)} observed · ${plotted.length} recorded price${plotted.length === 1 ? ' (a single observation)' : 's'}. Only recorded points are shown.`, 'ti-muted'));
  }

  const categories = new Map();
  for (const category of evidence.resale?.market?.categories ?? []) {
    if (category.id && category.title && ticketHistory(evidence, category.id).some(group => group.points.some(point => knownAmount(point.cents)))) {
      categories.set(category.id, category.title);
    }
  }
  for (const offer of evidence.offers) {
    if (offer.resaleTypeId && offer.category && offer.feeInclusive && knownAmount(offer.finalCents)) categories.set(offer.resaleTypeId, offer.category);
  }
  if (categories.size) {
    const label = element('label', 'History category', 'ti-history-filter');
    const filter = element('select');
    filter.add(new Option('Event overview', ''));
    for (const [id, name] of categories) filter.add(new Option(name, id));
    filter.addEventListener('change', () => {
      plot.dispatchEvent(new Event('ticket-chart-reset'));
      render(filter.value);
    });
    label.append(filter);
    head.append(label);
  }
  render();
}
