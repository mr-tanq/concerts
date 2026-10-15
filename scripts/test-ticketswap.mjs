import { ticketSwapRequest } from "./lib/ticketswap-api.mjs";

const search = await ticketSwapRequest("search_events", {
  query: "Lambert"
});

if (!Array.isArray(search.results)) {
  throw new Error("Unexpected search response");
}

const matches = search.results.filter(event =>
  event.__typename === "EventResult" &&
  event.name?.trim().toLowerCase() === "lambert" &&
  event.startDate?.slice(0, 10) === "2026-10-15" &&
  event.cityName === "Utrecht" &&
  event.locationName === "TivoliVredenburg" &&
  event.country?.code === "NL"
);

if (matches.length !== 1) {
  throw new Error(`Expected one exact event, found ${matches.length}`);
}

const event = matches[0];
console.log("Matched event:", JSON.stringify({
  name: event.name,
  date: event.startDate,
  venue: event.locationName,
  city: event.cityName,
  url: event.uri?.url
}, null, 2));

const listings = await ticketSwapRequest("get_event_listings", {
  event_id: event.id,
  listing_status: "AVAILABLE",
  currency: "EUR",
  limit: 30
});

console.log("Available listings:");
console.log(JSON.stringify(listings, null, 2));
