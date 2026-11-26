# Smart Ticket Watch readiness

PR #47 merged at `f1f74668`. This audit uses the supplied Parse.bot v15 excerpts. The new endpoints have not been called, and the excerpts omit parts of their response schemas. Fixtures test the proposed contracts. Existing `search_events` and `get_event_listings` retain their working POST transport.

## Parse.bot contract audit

| Endpoint | Supplied contract and current treatment | Confirm in a paid validation |
| --- | --- | --- |
| `get_market_batch` | EUR. AVAILABLE_ONLY accepts up to 10 unique type IDs or URLs and omits SOLD. FULL_MARKET accepts up to five and can return independent available and SOLD groups. The adapter detects partial results, contradictory per-item errors and missing pagination. The scheduler requires the requested type ID and parent event ID to match before trusting the group. | GET and JSON array encoding, provider envelope, per-item identity and error fields, independent group rows, cursor and completion flags, and whether type counts describe tickets or listings. |
| `get_event_demand` | EUR, one event ID. Keep demand wording and level text. Unknown flags stay unknown. The supplied scope is up to 50 eligible entrance types. No numeric waiting-list counts are inferred. | Whether event ID is echoed, event and type identity, shape and units of price levels, null/empty behavior and eligibility limits. |
| `get_events_sold_sample` | EUR, 1–10 distinct event IDs, 1–100 rows per event. The proposed query encoder supports an `{ id, after }` entry. The adapter binds each group to its event and retains coverage and pagination. SOLD rows are a sample of listings. | String versus cursor-object encoding, per-event cursor and coverage shape, no duplicates across pages, type IDs on unavailable categories, and whether quoted amounts are original or converted. No transaction timestamp or completed sale is inferred. |

The monitor requires a nonnegative, safe integer EUR buyer amount and a listing's explicit available quantity equal to its original lot size for an exact-quantity watch. Missing, invalid or mismatched quantities do not prove unavailability. The provider's v15 excerpt does not establish whether buyer totals are per ticket or per listing for multi-ticket quantities. The new endpoints stay gated until that distinction is independently verified. No currency conversion or division by quantity is guessed. Missing pagination cannot establish that all listings were seen.

## Bounded paid validation plan

**Maximum documented charge is 5 credits across 5 requests, with zero retries.** The four core requests cost 4 credits. The optional second SOLD page costs 1 credit. Run `node scripts/plan-ticket-watch-validation.mjs` to print the exact maximum entirely offline. The script cannot submit requests.

Get explicit owner approval for the 5-credit ceiling and selected IDs before execution. Confirm that the provider still charges one credit per listed endpoint and that the account can fund all five above its protected reserve. Otherwise stop and request a revised approval. The audited published snapshot contained no entries with ticket category IDs. Obtain a confirmed event and category ID from already verified evidence supplied by the owner or a future independently requested normal check. Paid search, identifier discovery and HTTP method fallbacks are outside this plan.

| Step | Exact request scope | Max credits |
| --- | --- | ---: |
| 1 | AVAILABLE_ONLY, one known type, EUR, `available_first=5`. | 1 |
| 2 | FULL_MARKET, same type, EUR, `available_first=5`, `sold_first=5`. | 1 |
| 3 | Demand, parent event only, EUR. | 1 |
| 4 | SOLD sample, same parent event, EUR, 5 rows. | 1 |
| 5 | One additional SOLD sample of 5 rows only when step 4 returns a usable next cursor for that event. | 1 |

Inspect the envelope and status on every response. Compare a visible single-ticket and multi-ticket listing, including lot sizes, currency and per-ticket all-in checkout amounts on the approved public marketplace. Skip sensitive checkout details and stop if a sample cannot show the distinction. Validate that available and sold pagination are independent, that no omitted group is interpreted as zero, and that each returned identifier refers to the expected event and type. Check charged and remaining headers against the before/after account balance. Missing, invalid or unexpected credit reporting stops the sequence until reconciled. Stop on any failed call, unexpected contract or unexpected charge. Keep only a redacted fixture and record failures as unresolved. If the first SOLD response has no next cursor, cursor retrieval remains unverified at a cost of 4 credits or less.

## Private storage and scheduler reliability

Watch preferences and alert state now require a separate GitHub repository whose authenticated metadata confirms private visibility and the exact repository name. Browser requests and worker requests recheck privacy before accessing each document. Access fails closed. The two public Watch files were empty in the audited history and are removed. The PWA drops older shell caches and refuses the old URLs. Private Watch data travels directly to GitHub's API and stays out of Pages, shared caches, Actions logs and public commits. Use purpose-scoped credentials and keep the private repository private. No automatic copying of prior public data occurs.

The worker re-reads private preferences before calling the provider and again before issuing new in-app alerts. Cancelled, paused or edited watches are skipped once the change is visible. A request already in flight may finish. Actual failures preserve the last observation and retry on a future dispatch with a 15-minute to six-hour bounded backoff. Budget and storage deferrals do not count as provider failures. A newer successful manual observation can reset the failure backoff. Stable notification IDs and known-state transitions suppress duplicates across retries. An increased cap can trigger a newly eligible threshold alert without replaying an unchanged availability alert. Stale observations cannot generate alerts.

The category selector previously used the market object captured when the parent card was built. It also missed categories learned by the Watch worker from SOLD samples. It now rereads current public market data and private category observations when opened, keeps only IDs from the current matching event and retains an explicitly missing saved preference. Category choices still depend on a successful observation or a sample. Older records may have no categories.

## Mobile Web Push

Listening Mirror already has an HTTPS PWA and service worker. Standard Web Push would add an explicit subscription control, a `push` event handler and notification click handling. iOS and iPadOS require a Home Screen web app and direct user interaction when asking permission. Feature-detect on Android and desktop browsers and keep in-app history available when push cannot be used. [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) · [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) · [MDN subscription API](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe)

An approved follow-up could store device subscriptions in the private Watch repository and let an authenticated Actions sender use VAPID. Keep the private VAPID key in an Actions secret. Configure revocation and expiry handling, and give push deliveries a durable ID per notification and per device. Avoid concert names, exact prices and other sensitive details on lock screens unless the owner explicitly opts in. Browser push services handle delivery, so subscription endpoints and encryption keys must stay private. Test permission denial, install requirements, offline delivery, account disconnect and expired subscriptions on real devices. No push enrollment or sending is implemented here. [Web Push protocol](https://www.rfc-editor.org/rfc/rfc8030.html) · [VAPID](https://www.rfc-editor.org/rfc/rfc8292.html)

## Production activation checklist

- [ ] Connect the app to a dedicated private GitHub repository from **Settings → Private Ticket Watch** with a repository-scoped token. Initialize the private repository with a README so it has a default branch. Configure `TICKET_WATCH_PRIVATE_REPOSITORY` and `TICKET_WATCH_PRIVATE_TOKEN` for the worker. Verify the repo is inaccessible without credentials and the public assets no longer serve the former paths.
- [ ] Run a no-provider preview and inspect the estimate privately. Save and pause a test watch. Verify that a manual TicketSwap snapshot or preview updates the private history and category controls.
- [ ] Confirm account credit policy, the known identifiers and the 5-credit validation ceiling. Record explicit owner authorization for the specific validation. Run the bounded plan once and reconcile charges. Leave the flags unset for unresolved contracts.
- [ ] Configure the GitHub `ticket-watch-live` environment with required owner review. Set the two existing live and contract flags only after verification. The live job also requires an owner-initiated dispatch. Configure daily/monthly limits and the protected reserve.
- [ ] Run one owner-approved manual monitoring dispatch using verified endpoints and inspect private deduplication, expiry and failure behavior. Verify existing TicketSwap remains independent.
- [ ] Approve a separate change for recurring monitoring or Web Push. No schedule or notification sender is enabled in this PR.
