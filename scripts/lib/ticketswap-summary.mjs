export function summarizeListings(data) {
  if (
    data?.listing_status !== "AVAILABLE" ||
    !Array.isArray(data.listings) ||
    typeof data.page_info?.has_next_page !== "boolean"
  ) {
    throw new Error("Unexpected TicketSwap listings response");
  }

  const seen = new Set();
  let availableTickets = 0;
  let lowestPriceCents = null;
  let missingPrices = false;

  for (const listing of data.listings) {
    if (!listing.id) throw new Error("Missing listing ID");
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);

    if (listing.event?.id !== data.event_id) {
      throw new Error("Listing belongs to a different event");
    }

    const count = listing.number_of_available_tickets;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid available ticket count");
    }
    if (!count) continue;

    availableTickets += count;

    const price = listing.converted_price?.total_price
      ?? listing.price?.total_price;

    if (
      price?.currency !== "EUR" ||
      !Number.isSafeInteger(price.amount) ||
      price.amount < 0
    ) {
      missingPrices = true;
      continue;
    }

    lowestPriceCents = lowestPriceCents === null
      ? price.amount
      : Math.min(lowestPriceCents, price.amount);
  }

  return {
    availableTickets,
    lowestPriceCents,
    currency: "EUR",
    complete: !data.page_info.has_next_page,
    missingPrices
  };
}
