# V2.4.3 Direct official ticket intelligence: audit and results

Live audit: 2026-11-26 and 27, Europe/Amsterdam. Scope: the 101 upcoming planned concerts in `data/planned.json`.

## Stored ticket links

| Stored `ticketUrl` | Concerts |
| --- | --- |
| Podiuminfo `/ticket/…` | 52 |
| Festivalinfo `/ticket/…` | 6 |
| Ticketmaster NL event | 1 |
| Stager shop event | 1 |
| None | 41 |

## How intermediary links work, and why they are not followed

Podiuminfo and Festivalinfo `/ticket/{id}/…` links are redirects to a seller chosen by the listing site. Both sites' `robots.txt` files were read live on 2026-11-26. Both state `Disallow: /ticket/*` for every user agent. The audit therefore did not request any `/ticket/` URL. Nothing in the code can request one either:

- `js/ticket-links.js` classifies these links as `intermediary`.
- The resolver only asks the reader whether robots allows the link. It records `robots-disallowed (Disallow: /ticket/*)` on the result.

Podiuminfo concert pages (`/concert/…`) are allowed and were read. They name no seller. Their only ticket links are the disallowed `/ticket/` redirect and a sponsored `/ticketswap/` link. That link is classified as `resale`.

The official seller is found where the venue publishes it:

1. The existing concert schedule discovery locates the venue's own event page. It searches the venue's agenda, its sitemap, or the organizer page (MOJO, Patronaat for PHIL). It runs over the same robots-respecting and paced reader.
2. The page must match artist and date, using the shared schedule parser. It must be on the venue's own host, or on an organizer host that also names the venue.
3. Only links in the main content count, never the nav or footer. Account, parking, premium, VIP and merchandise links are excluded.
4. A link counts as the official seller only if it is in the seller registry. The registry lists the hosts found during this audit:

   | Seller | Host |
   | --- | --- |
   | Ticketmaster | `ticketmaster.nl` / `.be` event URLs |
   | Stager | `*.stager.co/shop/…/events/{id}` |
   | 013 | `tickets.013.nl` |
   | Paradiso | `tickets.paradiso.nl` |
   | Parallel | `tickets.parallel.am` |
   | Doornroosje | `ticketshop.doornroosje.nl` |
   | TivoliVredenburg | `ticket.tivolivredenburg.nl` |
   | Paylogic | `shop.paylogic.com` |
   | Eventix | `shop.eventix.io` |

   The following are not official sellers:

   - **Resale:** TicketSwap, viagogo and StubHub, plus Ticketmaster resale paths.
   - **Unknown:** Ticketmaster artist pages.
   - **Unrelated:** account and order pages.
5. If a verified event page has no separate seller link, the event page itself is the verified destination (`venue-event-page`). This happens when its buy button is a script, or tickets come via an API, as with Ziggo Dome.

Event identifiers and shop parameters are kept, for example `?brand=nl_patronaat` and `?language=en-us`. Tracking parameters are removed: `utm_*`, `fbclid`, `gclid`, `msclkid`, `_ga` and similar.

## Cache

Results are stored on the concert's record in `data/official-ticket-offers.json` as `seller`. Each result is keyed by the concert identity (artist, date, venue, city, country) and by the stored ticket link. If either changes, the cache entry is invalid. Cache lifetimes:

| Result | Lifetime |
| --- | --- |
| Resolved | 7 days |
| Blocked (access control) | 3 days |
| Anything else | 1 day |

A failed re-resolution keeps the previous verified destination.

Each successful offer check also appends an observation to `history`, capped at 120 entries. Each observation records:

- seller and category
- advertised price, base price, fees and all-in total
- whether fees are included
- availability

The dashboard uses this history to build its price chart.

## Provider adapters

| Provider | Data read | Price | Fees | Categories | Availability |
| --- | --- | --- | --- | --- | --- |
| schema.org `Offer` (Paradiso, TivoliVredenburg, Ticketmaster, Stager) | JSON-LD | yes | only explicitly labelled | offer names | explicit `InStock` / `SoldOut` only |
| 013 | `Entree` price table | yes | "Incl. servicekosten" (amount not published) | row labels | sold-out/waitlist button text only |
| Doornroosje | ticket button | yes | not published | – | sold-out/waitlist button text only |
| AFAS Live | per-date ticket list, Ticketmaster link | yes, per category | "Alle prijzen zijn inclusief servicekosten" | yes (premium/VIP excluded) | not published |
| Paradiso / Parallel | the page's own event record | base + service fee | **amount** (e.g. €2,50) | – | `soldOut`, `waitingListUrl`, `eventStatus` |
| Ziggo Dome | public agenda API `/api/agenda/events/{id}` | per category | stated as included | yes | `showState` (`OnSale`) |
| Patronaat | existing event panel adapter | yes | – | – | – |

The final all-in price stays `null` for every adapter. No public page shows checkout-only charges, and checkout pages are either disallowed by robots or client-rendered. "Incl. servicekosten" is shown as context on the advertised price, not as a verified buyer total. For that reason, Official vs TicketSwap savings still appear only for a fee-inclusive, single-ticket, equivalent-category offer. The Paradiso membership exclusion and the TivoliVredenburg service-fee context are unchanged.

Playwright is not used anywhere in the pipeline. No account, checkout, cart or reservation request is made.

## Live validation results

The audit ran in two bounded passes with `scripts/audit-official-tickets.mjs`.

1. **First pass:** all 101 concerts, 428 requests.
2. **Second pass (`--fresh`):** the 35 concerts that were not resolved and had a supported venue, 269 requests. This pass came after a fix: an unreachable `robots.txt` had been recorded as a publisher refusal. It is now `unavailable` and is retried.

Every request:

- was paced to at most one per second per host,
- respected `robots.txt`,
- sent `ListeningMirrorTickets/1.0 (+repository URL)` as its user agent.

Access controls and 429 responses stopped all requests to that host. During probing, one request reached a `tickets.paradiso.nl` checkout shell before that host's `robots.txt` (`Disallow: /`) was applied. It returned a script shell with no event data, and nothing from it was used.

### By stored link

| Stored link | URLs examined | Official seller resolved | Price extracted | Availability verified | Fees evidenced | Not resolved |
| --- | --- | --- | --- | --- | --- | --- |
| Podiuminfo | 52 | 26 | 22 | 9 | 10 | 3 blocked · 2 ambiguous · 1 robots · 15 no matching page or source unavailable · 5 unsupported venue |
| Festivalinfo | 6 | 0 | 0 | 0 | 0 | 6 unsupported (festival sites are not verified publishers) |
| Ticketmaster (direct) | 1 | 1 | 0 | 0 | 0 | Ticketmaster blocks automated reads (`robots.txt` returns 403 `{"response":"block"}`) |
| Stager (direct) | 1 | 1 | 0 | 0 | 0 | `muziekgieterij.stager.co` robots disallows checks |
| No stored link | 41 | 23 | 8 | 2 | 4 | 3 robots · 8 no matching page or source unavailable · 7 unsupported venue |
| **Total** | **101** | **51** | **30** | **11** | **14** | |

"Availability verified" counts explicit stock states only: JSON-LD stock, the Paradiso event record, the Ziggo `showState`, or a sold-out or waitlist button. In this run it covers on-sale and sold-out states, for example Hermanos Gutiérrez (Paradiso waiting list, both nights).

Contradictory evidence is never confirmed. Bonobo at Gashouder is an example: the page's JSON-LD reports `InStock`, but its Ticketmaster button reads "Uitverkocht". Availability is therefore stored as `unknown` with an `availabilityConflict` note, and Bonobo is not counted above. Amounts on waiting-list or sold-out buttons, such as Paradiso's "Wachtlijst € 5,00", and offers named as a waiting list are never read as ticket prices. A plain "Tickets" link is never treated as availability.

### Resolved sellers

| Seller | Concerts | Venues |
| --- | --- | --- |
| Ticketmaster | 9 | Patronaat (5, one stored directly), AFAS Live (2), Gashouder, My Name is PHIL |
| Stager | 7 | Muziekgieterij (5, one stored directly), Baroeg (2) |
| 013 shop | 6 | 013 |
| Paradiso shop | 5 | Paradiso |
| Doornroosje shop | 4 | Doornroosje |
| Parallel shop | 1 | Parallel |
| Paylogic | 1 | Gashouder |
| Verified venue event page | 18 | Ziggo Dome (3, seller named Ticketmaster in public data), AFAS Live (3), 013 (2), Gashouder (2), Effenaar (2), Johan Cruijff ArenA (2), Melkweg, Bibelot, SPOT, Zik-Zak |

### By provider (offers extracted)

| Provider | Offers | Concerts | With explicit availability | With a fee amount |
| --- | --- | --- | --- | --- |
| schema.org JSON-LD (Paradiso) | 8 | 8 | 8 | 0 |
| 013 event page | 8 | 8 | 0 | 0 (included, amount not stated) |
| AFAS Live event page | 6 | 5 | 0 | 0 (included, amount not stated) |
| Doornroosje event page | 4 | 4 | 0 | 0 |
| Ziggo Dome public data | 3 | 3 | 3 | 0 (included, amount not stated) |
| Patronaat event panel | 2 | 2 | 0 | 0 |
| Paradiso/Parallel event record | 1 | 1 | 1 | 1 |

Sample observations:

| Concert | Seller | Price | Availability |
| --- | --- | --- | --- |
| Scientist (Parallel) | Parallel shop | €21,00 + €2,50 service fee = €23,50 | available |
| Amorphis (013) | 013 shop | €42,30, incl. service fees | – |
| Megadeth (AFAS Live) | Ticketmaster | General Admission and Rolstoelplatform, €100,98 each, incl. service fees | – |
| Nothing But Thieves (Ziggo Dome) | Ticketmaster | €50,40 | on sale |
| Hermanos Gutiérrez (Paradiso) | Paradiso | €55,40 | sold out, waiting list; €4,50 membership excluded |

### Unsupported or blocked sources

- **TivoliVredenburg** (13 concerts): every request returns a Cloudflare challenge (`cf-mitigated: challenge`, HTTP 403) from this network. It is treated as an access control and not retried. 3 concerts are recorded as `blocked`. 10 found no page, because the host was already in backoff.
- **Ticketmaster:** `robots.txt` returns 403. Ticketmaster purchase links found on venue pages are verified destinations, but their prices are not read.
- **Robots-disallowed:**
  - Stager shops (`*.stager.co`)
  - Paradiso, Parallel and Doornroosje checkouts (`Disallow: /`)
  - the Baroeg, Botanique, Theater aan het Vrijthof and dB's pages the audit tried to reach
- **No matching event page or source unavailable** (13 concerts, besides TivoliVredenburg): Vera, Paard, Neushoorn, De Doelen, De Bosuil, Stadsschouwburg Utrecht and Johan Cruijff ArenA.
  - Vera's configured agenda path `/events/` now returns 404, so the existing schedule discovery has a stale path.
  - Paard redirects its agenda to `/en/agenda-2/` and lists no matching link.
- **Ambiguous:** 2 Carré nights. The organizer page lists several shops and the venue page did not verify the night.
- **Unsupported venues** (18 concerts): venues and festivals with no verified official publisher in the existing registry. This covers all 6 Festivalinfo festivals, plus Bitterzoet, De Helling, Metropool, Martiniplaza and others. No seller URL is made up for them.

## When verification fails

If no verified destination exists, the Ticket Intelligence window still offers the stored ticket link. It appears as a dashed secondary button labelled, for example, "Tickets via Podiuminfo · unverified", and never as "Official tickets". The existing Tickets links on Going cards and concert sheets are unchanged.

## Remaining limitations

- **No verified all-in totals.** Checkout charges are not visible on any permitted public page, so savings comparisons still need the manual import (`scripts/record-official-offer.mjs`) or a source that publishes all-in prices.
- **TivoliVredenburg** is only reachable through the existing GitHub Actions path, where earlier checks succeeded. The Cloudflare challenge seen here may differ by network. It is never bypassed.
- **Ticketmaster** prices and availability remain unknown without an authorized integration.
- **Discovery gaps:** Vera, Paard and Carré, and venues outside the publisher registry, need registry updates in the schedule discovery. Those updates are out of scope here and listed as follow-ups.
- **Snapshot age.** The audit snapshot is from 2026-11-27. Offers older than 6 hours appear as "Last verified", and resolved sellers expire after 7 days. Nothing schedules a refresh: checks run only from the in-app request or a manual workflow dispatch.
- **Branch only.** The audit data is committed on this branch only. No deployment, merge, recurring monitoring, Parse.bot call, paid service or purchase was made.

## Commands

```sh
node scripts/audit-official-tickets.mjs --only 'podiuminfo-467043' --report /tmp/report.json   # read-only
node scripts/audit-official-tickets.mjs --write                                           # update the offer store
node scripts/refresh-official-tickets.mjs CONCERT_ID [--live]                             # one concert
```
