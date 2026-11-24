# Listening Mirror

A personal music diary: what you're listening to right now, the concerts worth
going to next, and every night you've been to since 2001.

It runs entirely on GitHub. The repo is the database (JSON files in `data/`),
GitHub Pages serves the app, and scheduled GitHub Actions do the "backend"
work. The only other moving part is a small Supabase relay that carries
now-playing state from the Android companion to Mirror.

## The app

Five tabs, built for a phone (installable to the home screen as a PWA):

| Tab | What it is |
|---|---|
| **Mirror** | What's playing now (Spotify Web, or Spotify / YouTube / YouTube Music / ambient radio via the Android companion), with synced lyrics and the ambient-recognition remote. |
| **Realm** | Your concerts and listening as a hand-drawn atlas — countries and cities that matter to you glow. |
| **Live** | *Deciding* — swipe on concerts discovered from your listening (right = going, left = pass, Later = skip for now). *Going* — your plan, filtered by **Tickets / Interested / All**, with list or calendar view, next-night countdown, timetables, warm-up setlists, TicketSwap and work-day badges. *Set aside* — everything you passed on, restorable. |
| **Self** | Who you are according to what you play: listening landscape over time, editorial moments, top artists. |
| **Archive** | Every concert since 2001: overview, milestones, on-this-day, search by artist / venue / city / year, and per-night sheets with setlist, who you actually saw, and notes. |

Swipes, tickets, notes and "I went" write straight to the repo from the
browser through the GitHub Contents API, using a fine-grained token you enter
once in Settings (kept only in that browser's storage).

## Layout

```
index.html, css/, js/          the static app (no build step)
sw.js, manifest.webmanifest    PWA: home-screen install, always-fresh code, offline shell
data/archive.json              permanent concert history — the source of truth
data/planned.json              Going (with tickets, work arrangements, schedules)
data/recommendations.json      the Deciding deck
data/recommendation-history.json  what you passed on
data/identity.json, listening-timeseries.json, artist-*.json  Self / Realm inputs
data/*-cache.json              source caches kept by the discovery jobs
scripts/                       everything the workflows run, plus *.test.mjs
android-companion/             Android app: media relay + ambient recognition → Mirror
android-app/                   minimal Android WebView wrapper around the site
supabase/migration.sql         relay schema (private tables + SECURITY DEFINER RPCs)
```

## Data sources

- **Last.fm** — your listening signal (top / recent / similar artists).
- **Podiuminfo** — NL/BE concert agenda, scanned day by day.
- **Festivalinfo** and official festival sites — festival line-ups and artwork.
- **setlist.fm** — setlists for archive nights and warm-up setlists for Going.
- **TicketSwap** — resale availability for Going concerts.

Discovery is NL-first by design (`data/config.json`: home city, search
countries, radius, score weights). Adding another source means one adapter in
`scripts/sources/` returning the same concert shape.

## Workflows

| Workflow | When |
|---|---|
| Discover concerts | 13:00 & 19:00 UTC — cheap run on cached days |
| Discover concerts (daily deep refresh) | 07:00 UTC — re-checks every day in the window |
| Refresh concert schedules | every 30 min — timetables / set times for Going |
| Fetch identity | twice daily |
| Fetch listening history, Fetch artist origins | weekly |
| Fetch setlists, warm-up setlists, TicketSwap, Search a concert | when the app writes a request file |
| Plan / Dismiss / Import concert | manual fallbacks for what the app does directly |
| Tests | every push / PR touching code — syntax check + full `scripts/*.test.mjs` |
| Build Android companion APK | on changes in `android-companion/`, or by hand |

### Secrets (Settings → Secrets and variables → Actions)

| Secret | Used for |
|---|---|
| `LASTFM_API_KEY`, `LASTFM_USER` | discovery, identity, listening history |
| `SETLISTFM_API_KEY` | setlists |
| `PARSE_API_KEY` | TicketSwap refresh |

## Local development

```sh
npm ci
node --test scripts/*.test.mjs      # full test suite
python3 -m http.server              # then open http://localhost:8000
```
