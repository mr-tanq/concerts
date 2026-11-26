# Ticket Intelligence browser review

The screenshots are from Chromium running the real Listening Mirror app, opened from **Live → Going → Ticket Intelligence**. Each screenshot is labeled **OFFLINE FIXTURE**. The concert date, market figures, official offers and Watch data are illustrative fixture data. The Barrens artist photograph is the existing repository asset. The harness intercepts all application requests, including both GitHub refresh queues and the private Watch repository.

| Screenshot | Viewport | What to review |
| --- | --- | --- |
| [Mobile dashboard](01-mobile-dashboard.jpg) | 412 px | Full-screen window, artwork, buyer totals, qualified price difference and purchase links |
| [Desktop modal](02-desktop-modal.jpg) | 1280 px | Centered modal, source freshness and comparison |
| [Price history](03-price-history.jpg) | 1280 px | Actual fixture observation dates, the missing resale interval, category filter and point inspection |
| [Smart Ticket Watch](04-watch-configuration.jpg) | 412 px | Existing private preferences, latest alert, estimate, pause and remove |
| [Missing data](05-missing-data.jpg) | 320 px | Honest unknown prices and narrow-screen layout |
| [Loading](06-loading.jpg) | 768 px | Pending saved evidence |
| [Error](07-error.jpg) | 768 px | Recoverable source failures with the explicit checks still available |
| [Market overview](08-market-overview.jpg) | 1280 px | Category supply, SOLD sample and distinct demand quantities |

The browser harness checks 320, 375, 412, 768 and 1280 px, artwork loading, no horizontal overflow, keyboard/Escape and browser Back dismissal, focus and scroll restoration, category filtering, private Watch display and explicit refresh acknowledgements. Run `node scripts/fixtures/ticket-intelligence-review.mjs` from the repository root with Playwright installed locally. Optionally set `PLAYWRIGHT_MODULE` to a local Playwright module and `CHROMIUM_PATH` to a system Chromium binary. The harness blocks external traffic and supports an optional local Google Fonts cache through `TICKET_REVIEW_FONTS`. Captures default to this directory. Set `TICKET_REVIEW_OUTPUT` to capture elsewhere.
