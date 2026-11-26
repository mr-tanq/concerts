# Direct official ticket audit — 2026-11-26

101 upcoming planned entries: 52 Podiuminfo ticket links, 6 Festivalinfo ticket links, 1 Ticketmaster NL, 1 Stager, 41 without ticketUrl. Intermediary URLs are not official seller evidence. Direct eligible sources now take priority, Stager event URLs can be checked using the existing strict structured-event parser, and non-UTM query parameters survive. Existing venue fallbacks and robots checks remain.

Public inspection of the MONO Podiuminfo and Roadburn Festivalinfo ticket URLs and both robots.txt URLs was unsuccessful from the available browser search tool. No live extraction or permission was established. Do not enable intermediary redirect traversal until actual permitted redirect behavior and destination allowlists are verified. No Playwright or checkout adapter is added. No paid API calls, reservations or purchases. The new tests are offline fixtures; CI must confirm them before merge.
