const id = value => typeof value === 'string' && value.trim() && value.length <= 500;
const label = value => typeof value === 'string' ? value.trim().slice(0, 240) : null;
const limit = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
const requireId = value => {
  if (!id(value)) throw new Error('Invalid TicketSwap identifier');
  return value;
};

function typeIdentifier(value) {
  requireId(value);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['ticketswap.com', 'www.ticketswap.com'].includes(url.hostname)
      || url.username || url.password || url.port) throw new Error('Invalid TicketSwap ticket type URL');
  } else if (!/^[a-zA-Z0-9._~+/=-]+$/.test(value)) throw new Error('Invalid TicketSwap ticket type ID');
  return value;
}

function unique(input, max) {
  if (!Array.isArray(input) || !limit(input.length, max) || new Set(input).size !== input.length) {
    throw new Error('Invalid TicketSwap batch size or duplicate identifier');
  }
}

function group(value) {
  if (value == null) return null;
  if (!Array.isArray(value.listings)) return null;
  const pagination = value.page_info;
  return {
    listings: value.listings,
    complete: pagination?.has_next_page === false,
    cursor: id(pagination?.end_cursor) ? pagination.end_cursor : null
  };
}

export function createTicketWatchAdapters(request) {
  return {
    async marketBatch(eventTypes, { mode = 'AVAILABLE_ONLY', availableFirst = 30, soldFirst } = {}) {
      if (!['AVAILABLE_ONLY', 'FULL_MARKET'].includes(mode)
        || !limit(availableFirst, 100)
        || (mode === 'AVAILABLE_ONLY' && soldFirst !== undefined)
        || (mode === 'FULL_MARKET' && soldFirst !== undefined && !limit(soldFirst, 100))) {
        throw new Error('Invalid TicketSwap market batch options');
      }
      unique(eventTypes, mode === 'AVAILABLE_ONLY' ? 10 : 5);
      const event_types = eventTypes.map(typeIdentifier);
      const raw = await request('get_market_batch', { mode, event_types, currency: 'EUR',
        available_first: availableFirst, ...(soldFirst === undefined ? {} : { sold_first: soldFirst }) });
      if (!Array.isArray(raw?.results)) throw new Error('Invalid TicketSwap market batch response');
      return {
        results: raw.results.map(item => ({
          typeId: id(item?.event_type_id) ? item.event_type_id : null,
          found: item?.found === true,
          error: label(item?.error),
          eventType: item?.event_type,
          available: group(item?.available),
          sold: mode === 'FULL_MARKET' ? group(item?.sold) : null
        })),
        requested: raw.event_types_requested,
        found: raw.event_types_found,
        operations: raw.operations_sent
      };
    },

    async eventDemand(eventId) {
      const id = requireId(eventId);
      const raw = await request('get_event_demand', { event_id: id, currency: 'EUR' });
      if (!raw?.demand || (raw.event_id !== undefined && raw.event_id !== id)
        || !Array.isArray(raw.event_types)) throw new Error('Invalid TicketSwap demand response');
      return {
        hasDemand: typeof raw.demand.has_demand === 'boolean' ? raw.demand.has_demand : null,
        title: label(raw.demand.title), intro: label(raw.demand.intro), recentlySold: label(raw.demand.recently_sold),
        types: raw.event_types.slice(0, 50).map(type => ({
          id: label(type?.id), title: label(type?.title),
          instantSellable: typeof type?.demand?.instant_sellable === 'boolean' ? type.demand.instant_sellable : null,
          updatedAt: Number.isFinite(Date.parse(type?.demand?.updated_at)) ? type.demand.updated_at : null,
          priceLevels: Array.isArray(type?.demand?.price_levels) ? type.demand.price_levels.map(level => ({
            text: label(level?.text), price: level?.price ?? null, convertedPrice: level?.converted_price ?? null
          })) : []
        }))
      };
    },

    async soldSample(events, { rowsPerEvent = 25 } = {}) {
      if (!Array.isArray(events) || !limit(rowsPerEvent, 100)) throw new Error('Invalid sold sample options');
      const ids = events.map(value => requireId(typeof value === 'string' ? value : value?.id));
      unique(ids, 10);
      const event_ids = events.map((value, i) => {
        if (typeof value === 'string') return ids[i];
        return { id: ids[i], after: requireId(value.after) };
      });
      const raw = await request('get_events_sold_sample', { event_ids, rows_per_event: rowsPerEvent, currency: 'EUR' });
      if (!Array.isArray(raw?.results)) throw new Error('Invalid TicketSwap SOLD sample');
      return ids.map(eventId => {
        const matches = raw.results.filter(item => item?.event_id === eventId);
        const first = matches.length === 1 ? matches[0] : null;
        return { eventId, found: first?.found === true, error: label(first?.error_kind),
          group: group(first), coverage: first?.coverage ?? null };
      });
    }
  };
}
