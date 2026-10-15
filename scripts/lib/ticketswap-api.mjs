const BASE =
  "https://api.parse.bot/scraper/4a34adf3-5a3c-4e01-ad98-1cc9204d5dbd";

export async function ticketSwapRequest(endpoint, params) {
  const allowed = new Set(["search_events", "get_event_listings"]);
  if (!allowed.has(endpoint)) {
    throw new Error("Unsupported TicketSwap endpoint");
  }

  const key = process.env.PARSE_API_KEY;
  if (!key) throw new Error("Missing PARSE_API_KEY");

  const response = await fetch(`${BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "X-API-Key": key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error(`TicketSwap request failed: HTTP ${response.status}`);
  }

  const result = await response.json();
  if (result.status !== "success" || result.data == null) {
    throw new Error("TicketSwap returned an unsuccessful response");
  }

  return result.data;
}
