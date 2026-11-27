# Yoda — a desktop pet for Android

A small chocolate French bulldog who walks along the bottom of the phone
screen, on top of other apps.

| You do | Yoda does |
|---|---|
| Tap him | Speech bubble with the song playing now — from any music app on the phone, or your Spotify account on any device |
| Double-tap him | Jumps and plays a random song from your Spotify Liked Songs (top tracks if you have none) |
| Hold him | Menu: **Encourage me**, **Say something funny**, **Check in on me**, **Email alerts on/off** |
| — | 5 minutes before a Google Calendar meeting: speech bubble with the meeting, time and place (**Open** / **Got it**) |
| — | New Gmail: "New email from …" with the subject and an **Open it** button |
| Nothing for a while | Stands, sits, and eventually naps |

## Install

1. Download `yoda.apk` from the
   [yoda-latest release](https://github.com/mr-tanq/concerts/releases/tag/yoda-latest)
   on the phone and open it (allow installing from your browser if asked).
2. Open **Yoda** and tap **Allow** on each step:
   - *Display over other apps* — required.
   - *Calendar* — meeting reminders (reads the calendars synced to the phone, so Google Calendar works without a Google sign-in).
   - *Gmail alerts* — notification access. On Android 13+ a sideloaded app first shows
     "Restricted setting": go to **Settings → Apps → Yoda → ⋮ → Allow restricted settings**, then try again.
     Gmail's own notifications must be on.
   - *Notifications* and *Run in background* — keep Yoda alive.
3. **Spotify** (one time): on <https://developer.spotify.com/dashboard>, open your app → Settings →
   add the Redirect URI `yoda-pet://spotify-callback` → Save. Then tap **Connect Spotify** in Yoda.
   - Playing a chosen song needs Spotify **Premium**. On Free, Yoda opens the song in Spotify instead.
   - If the app is in Development mode, your Spotify account must be listed under *User Management*.
4. Tap **Show Yoda 🐾**.

## How it works

- `PetOverlay` — two `TYPE_APPLICATION_OVERLAY` windows (the dog, the speech bubble); walk cycle at ~7 fps, movement at 30 fps, paused while the screen is off.
- `YodaService` — foreground service that keeps him on screen and checks `CalendarContract.Instances` every 30 s.
- `GmailListener` — `NotificationListenerService` that reads only Gmail's notifications (sender = title, subject = text). Nothing is stored or sent anywhere.
- `SpotifyClient` — Spotify Web API with PKCE sign-in (Client ID only, no secret, no Spotify SDK).
- No third-party libraries.

Build locally: `./gradlew :app:testDebugUnitTest :app:assembleDebug` (needs the Android SDK; set `sdk.dir` in `local.properties`).
Sprites were cut out of the supplied artwork into `app/src/main/res/drawable-nodpi/`.
