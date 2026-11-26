const BASE =
  "https://api.parse.bot/scraper/4a34adf3-5a3c-4e01-ad98-1cc9204d5dbd";

export async function ticketSwapRequest(endpoint, params) {
  const allowed = new Set(["search_events", "get_event_listings"]);
  if (!allowed.has(endpoint)) {
    throw new Error("Unsupported TicketSwap endpoint");
  }

  const key = process.env.PARSE_API_KEY;
  if (!key) throw new Error("Missing PARSE_API_KEY");

  let response;
  try {
    response = await fetch(`${BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        "X-API-Key": key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    throw new Error(`TicketSwap ${endpoint}: ${error?.name === "TimeoutError" ? "request timed out" : "network request failed"}`);
  }

  if (!response.ok) {
    let details = "";
    try {
      const body = await response.json();
      const error = body?.error;
      if (typeof error?.kind === "string" && /^[a-z0-9_]{1,60}$/i.test(error.kind)) {
        details += `, ${error.kind}`;
      }
      if (Number.isInteger(error?.upstream_status_code)) {
        details += `, upstream HTTP ${error.upstream_status_code}`;
      }
    } catch {}
    throw new Error(`TicketSwap ${endpoint}: HTTP ${response.status}${details}`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`TicketSwap ${endpoint}: invalid JSON response`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`TicketSwap ${endpoint}: invalid response`);
  }
  if ("status" in result || "data" in result) {
    if (result.status !== "success" || result.data == null) {
      throw new Error(`TicketSwap ${endpoint}: unsuccessful response`);
    }
    return result.data;
  }
  if ("error" in result) throw new Error(`TicketSwap ${endpoint}: unsuccessful response`);
  return result;
}
