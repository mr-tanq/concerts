# Listening Mirror

A concert archive + discovery system. 100% GitHub — no Cloudflare, no servers.
The repo itself is the database (JSON files), GitHub Pages serves the frontend,
and GitHub Actions does the "backend" work on a schedule.

Discovery is deliberately minimal: **Last.fm** for your listening signal,
**Podiuminfo** for concert search (NL/BE only, by design — see below).

## How it works

```
data/archive.json   ← permanent history, since 2001 (source of truth)
data/planned.json   ← concerts discovered by matching your listening to live shows
data/config.json    ← your location, which sources to use, scoring weights

scripts/discover-concerts.mjs      → run by a scheduled GitHub Action
scripts/sources/podiuminfo.mjs     → Podiuminfo event-database adapter
scripts/import-to-archive.mjs      → run manually when you actually go to a show
```

Nothing writes to the repo from the browser. The static site (`index.html` +
`js/app.js`) only *reads* `data/*.json` and computes everything client-side
(`js/archive-stats.js` — Overview, Signature, Milestones, Timeline, Patterns
all come from the exact same array, so they can never drift from each other).

## Setup

1. Push this to a repo named `listening-mirror` and turn on **GitHub Pages**
   (Settings → Pages → deploy from branch, root).

2. Add two secrets under **Settings → Secrets and variables → Actions**:
   | Secret | Where to get it |
   |---|---|
   | `LASTFM_API_KEY` | last.fm/api/account/create |
   | `LASTFM_USER` | your Last.fm username |

   That's the whole list. No Spotify OAuth, no Ticketmaster/Bandsintown keys.
   Podiuminfo needs no key at all — it's a public search
   (`scripts/sources/podiuminfo.mjs`), not an API with auth.

3. The **Discover concerts** workflow runs twice a day (edit the cron in
   `.github/workflows/discover-concerts.yml`) and commits an updated
   `data/planned.json`. You can also trigger it manually from the Actions tab.

4. When you actually attend a concert: go to **Actions → Import concert to
   archive → Run workflow**, paste the concert's `id` from `data/planned.json`,
   and it moves the record into `data/archive.json` (dedup-checked) and
   removes it from planned. This is the one deliberately manual step —
   "I went" is a fact only you can confirm.

## Why only NL/BE

Podiuminfo's whole database is the Dutch/Belgian club and festival circuit —
that's exactly why it catches your local shows better than a generic API. The
trade-off: if you go to a concert outside NL/BE (Greece, for instance — your
archive shows Athens is actually your #1 city with 50 shows), Podiuminfo
won't surface it, no matter how well the matching works. You confirmed you're
NL/BE-only going forward, so this is intentional, not an oversight. If that
changes later, dropping in another source (Bandsintown, Ticketmaster, a
country-specific site) is one adapter function with the same output shape as
`queryPodiuminfo` in `scripts/discover-concerts.mjs`.

## What's implemented vs. what's next

**Done in this pass:**
- Archive data schema + full stats engine (Overview / Signature / Milestones
  / Patterns / Timeline / On This Day) — the part you called most important,
  so it's the most complete.
- Concerts discovery pipeline: Last.fm weighted artist list → Podiuminfo
  event-database search → scored, deduped, geo-filtered results →
  `planned.json`. Podiuminfo search is event-based (not artist-page based),
  so it naturally handles multi-band lineups, festival appearances, and the
  same artist on multiple nights/venues (each is its own Podiuminfo concert
  id, which doubles as the dedup key).
- Import-to-archive flow with duplicate protection.

**One honest caveat on Podiuminfo parsing:** the adapter was built by reading
the site through a markdown-rendering fetch, not raw HTML, so date/city
extraction is a best-effort heuristic. Run
`node scripts/sources/podiuminfo.mjs "Mono"` locally (after `npm install`) to
sanity-check it, or add `--dump` to print raw HTML from a real search page —
if dates or cities come out wrong, send me that dump for a precise fix.

**Still stubbed / next steps:**
- **Mirror**, **Realm**, **Identity** tabs are placeholders — say the word
  and we bring those back once Concerts/Archive are solid for you.
- Tune the scoring/matching once you've got real Last.fm data flowing and
  can point me at concerts it should (or shouldn't) have found.
