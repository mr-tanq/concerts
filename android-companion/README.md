# Listening Mirror — Android companion (Phase 3: free Shazam/SongRec ambient)

Android device-playback detection plus optional user-started ambient music
recognition, transported as the same normalized CurrentListeningState through
the existing Supabase relay.

Phase 3 keeps the working Phase 2C remote-control/background architecture but
changes the automatic ambient recognizer to a zero-credential Shazam/SongRec
fingerprint path. The phone creates a compact fingerprint locally and sends that
fingerprint to Shazam's undocumented recognition endpoint; raw microphone audio
is not uploaded to the Listening Mirror backend. AudD code/token storage remains
only as a manual rollback path and is never called automatically.

## What this does

Reads what's currently playing on the phone via Android's MediaSession
APIs (Spotify, YouTube, YouTube Music, or any other well-behaved media
app), normalizes it into the same generic `CurrentListeningState` shape
the web Mirror already understands, and displays every raw + normalized
field on one live debug screen. When Ambient is explicitly started, the app
can also sample external music through the microphone and publish an
`ambient_audd` state when no active device MediaSession already identifies it.

## Structure

```
app/src/main/java/com/listeningmirror/companion/
  model/
    RawSessionSnapshot.kt      pure snapshot of one MediaController
    CurrentListeningState.kt   the generic contract (Android side)
  logic/                       ALL pure, unit-testable, zero android.* imports
    SourceMapper.kt            package name -> source string
    PositionNormalizer.kt      sentinel/timestamp handling
    DurationNormalizer.kt      negative-means-unknown handling
    MetadataCompleteness.kt    metadataCompleteForLyrics
    ActiveSessionSelector.kt   which session is actually active
    StateNormalizer.kt         snapshot -> CurrentListeningState
  android/                     Android lifecycle / service / debug UI
    MediaNotificationListenerService.kt   permission gate only
    AndroidMediaSessionProvider.kt        event-driven MediaSession bridge
    DebugActivity.kt                      the debug screen + Ambient ON/OFF
    AmbientRecognitionService.kt         microphone FGS, recognition loop
    AmbientSettingsActivity.kt           legacy AudD rollback settings
  ambient/                     ambient capture + recognition providers
    ShazamFingerprint.kt                 local 16 kHz SongRec-compatible fingerprint
    ShazamRecognitionClient.kt           keyless Shazam recognition transport
    AudDRecognitionClient.kt             legacy manual rollback client only
    AmbientAudioRecorder.kt              variable-rate mono PCM16 capture
    AmbientTokenStore.kt                 encrypted legacy AudD token storage
app/src/test/java/.../LogicTests.kt       kotlin.test unit tests
tools/VerifyRunner.kt                     standalone runner (see below)
```

## Build

```
./gradlew :app:assembleDebug
```
APK lands at `app/build/outputs/apk/debug/app-debug.apk`.

The Gradle wrapper IS included (gradlew, gradlew.bat, gradle/wrapper/),
so this command works as written -- but it still requires an Android SDK
(compileSdk 35) plus network access to Google's Maven repo on first run,
neither of which the wrapper can provide. Easiest path: open the project
in Android Studio and let it sync.

## Run the unit tests

```
./gradlew :app:testDebugUnitTest
```

`tools/VerifyRunner.kt` is a standalone duplicate of the same assertions
that runs without Gradle/JUnit/Android SDK — useful for verifying the pure
logic anywhere a JVM + kotlinc exist:

```
kotlinc app/src/main/java/com/listeningmirror/companion/model/*.kt \
        app/src/main/java/com/listeningmirror/companion/logic/*.kt \
        app/src/main/java/com/listeningmirror/companion/ambient/ShazamFingerprint.kt \
        app/src/main/java/com/listeningmirror/companion/transport/ArtworkPolicy.kt \
        app/src/main/java/com/listeningmirror/companion/transport/PositionReanchor.kt \
        app/src/main/java/com/listeningmirror/companion/android/KeepaliveLifecycle.kt \
        tools/ManifestChecks.kt tools/VerifyRunner.kt \
        -include-runtime -d verify.jar
java -jar verify.jar
```

## Lifecycle (important)

MediaSession observation is owned by MediaNotificationListenerService,
NOT by the debug Activity. Leaving the Activity to go use Spotify or
YouTube unsubscribes only the UI -- observation keeps running, which is
the entire point. ObservationHub is the seam between the two.

## Notification Access

Android only exposes media sessions to apps with Notification Access. The
app shows whether it's granted and provides a button to open the system
settings page. Granted once, persists.

Declared permissions are deliberately narrow: INTERNET for relay transport,
FOREGROUND_SERVICE + FOREGROUND_SERVICE_SPECIAL_USE for the playback keepalive,
POST_NOTIFICATIONS for visible foreground notifications, plus RECORD_AUDIO and
FOREGROUND_SERVICE_MICROPHONE for the user-started Ambient mode. RECORD_AUDIO
is requested only when the user taps Start ambient recognition. No location.


## Ambient recognition (Phase 3)

Ambient mode remains opt-in and runs in the same microphone foreground service
introduced in Phase 2A and remotely controlled by Phase 2C. Spotify/YouTube
MediaSessions still have priority, so ambient recognition is suspended while
device playback already identifies the track.

The Phase 3 automatic provider is **Shazam/SongRec**:

1. capture a 3-second 16 kHz mono PCM16 microphone sample;
2. reject near-silence locally;
3. build a SongRec-compatible Shazam fingerprint on-device;
4. send only the compact fingerprint to Shazam's undocumented recognition endpoint;
5. if there is no match, try a 6-second sample;
6. publish artist/title/album/artwork and Shazam match offset through the existing relay.

No Apple Developer account, ShazamKit credential, AudD request, or other paid API
is used by the automatic path. The old AudD client and encrypted token screen are
retained only for an explicit future manual rollback. There is deliberately no
automatic paid fallback. HTTP 429/rate-limit responses are surfaced and retried
later.

The relay source id remains `ambient_audd` for backward compatibility with the
existing Mirror arbitration/source-icon code; the recognition provider behind
that id is Phase 3 Shazam/SongRec.

The Shazam endpoint is unofficial/undocumented and therefore may change. The
fingerprinting implementation is derived from GPL-3.0-or-later SongRec/Audile
work; see `LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Relay transport (Phase 1B-2)

`transport/` publishes the selected session's normalized state to
`public.publish_playback` on Supabase:

- immediate publish on meaningful change, coalesced by a 750ms debounce
- 20s heartbeat while a session is selected, with the position re-anchored
  to the heartbeat instant via SystemClock.elapsedRealtime()
- per-install deviceId + monotonic sequence under noBackupFilesDir, so a
  reinstall starts a fresh identity rather than restoring a stale one
- write secret encrypted with an Android Keystore AES/GCM key
- artwork transported only when http(s); content:// and bitmaps become null

Setup: open the app, tap "Relay transport settings", paste the write secret
once. Project URL and anon key are public config compiled into RelayConfig.

Canonical backend SQL: `supabase/phase1b2_transport.sql`.

## Background reliability (Phase 1C)

`PlaybackRelayForegroundService` keeps the process at foreground importance
so observation and the 20s heartbeat survive backgrounding and screen-off.
Added because a real Samsung S23 suspended the process: with YouTube
genuinely playing, Supabase `received_at` aged to 39s against a 20s
heartbeat, and the web correctly expired the state after 60s.

Its lifecycle follows the **NotificationListenerService connection**, never
playback state — a paused track or a momentarily-null session must not stop
it. `specialUse` foreground service type (not `dataSync`, which carries
Android 15 runtime time limits). A persistent low-importance notification is
a platform requirement for any foreground service.


## YouTube metadata confidence (Phase 1C.1)

`METADATA_KEY_ARTIST` on ordinary YouTube is often the UPLOADER, not the
musical artist (observed: `Rock & Roll Hall of Fame`). `YouTubeMetadataResolver`
therefore promotes it to canonical only on explicit evidence:

1. `<Artist> - Topic` auto-generated channel
2. the title's leading segment equals the uploader
3. exactly one separator AND an official-video/audio marker

Anything else leaves `artist = null`. Unresolved beats confidently wrong: a
bad artist breaks lyrics, identity, artwork lookup and future history at once.
Spotify metadata is canonical and never re-derived.

## Artwork (Phase 1C.1)

`ArtworkResolver`, in order: browser-safe http(s) URI, then a YouTube
thumbnail from a **verified** video URL (a bare ID-shaped string is not
verification). Bitmap fallback is NOT implemented — see delivery notes.

## Foreground startup

`KeepaliveStatus` reports ACTIVE only after the service genuinely reaches
`startForeground()`. A background start rejected by Android 12+ is recorded,
never swallowed. The visible Activity subscribes to ObservationHub lifecycle
state, so it also retries if the NotificationListener finishes connecting only
after the Activity is already visible; no reopen/polling race remains.


## Phase 1C.1 audit corrections

- listener reconnect replaces provider/publisher without first killing an already-active FGS
- service `onDestroy()` clears keepalive ACTIVE diagnostics
- YouTube official markers are trailing closed-list suffixes only
- mixed dash types use the actual earliest separator/prefix match
- guarded exact `Artist - Track` parsing resolves the observed Radio Nova / Ezechiel Pailhes case while rejecting reaction/live-descriptor counterexamples
- debug screen exposes raw uploader, artist candidate/provenance, media URI, raw artwork URIs, bitmap availability and resolved artwork kind
- bitmap artwork upload remains deferred until a secure authenticated storage path exists


### Phase 2A.1 / Phase 3 capture diagnostics
The signal diagnostics and Android input-source selection are preserved: UNPROCESSED when supported, otherwise VOICE_RECOGNITION, with RMS/peak dBFS reporting and a local near-silence gate. Phase 3 requests direct 16 kHz PCM16 captures for Shazam fingerprinting; the legacy AudD path retains its former 44.1 kHz/8-second defaults but is not called automatically.


## Phase 2B companion controls

The launcher label is now **Listening Mirror Companion**. Ambient recognition still requires
`RECORD_AUDIO`, but after the one-time permission/token setup it no longer requires reopening
the diagnostics screen for everyday use:

- the always-on playback-detection notification has a **Start ambient** action;
- Android treats an explicit notification interaction as a valid user-started path for a
  microphone foreground service;
- while ambient recognition is active, its own ongoing notification has **Stop ambient**;
- the ambient service is sticky only for system recovery of an already user-started session.
  An explicit Stop does not resurrect it.


## Phase 2C remote control

After one explicit user start (notification or visible Activity), the microphone
foreground service remains armed while remote Ambient is OFF. OFF cancels the
recorder/recognition worker and clears the ambient relay candidate but keeps the
service ready. Mirror writes desired ON/OFF state using its existing relay read
credential; the Companion polls that control state with its existing write secret
and ACKs each command. Explicit notification/app Stop still terminates the service.
