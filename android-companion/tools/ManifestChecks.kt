import java.io.File

/**
 * Static assertions over the real AndroidManifest.xml and sources.
 *
 * These exist because the foreground-service contract is enforced by the
 * PLATFORM at install/runtime, not by the Kotlin compiler -- a missing
 * permission or a wrong foregroundServiceType produces a crash on a real
 * Samsung, not a build error. Cheap text assertions catch that in CI.
 *
 * Deliberately NOT pretending to unit-test Android's background scheduling:
 * whether Samsung actually keeps the process alive is a real-device
 * question, and no fake test here would answer it.
 */
object ManifestChecks {

    private fun locate(relative: String): File? =
        listOf(relative, "../$relative", "app/$relative")
            .map(::File).firstOrNull { it.exists() }

    fun run(check: (String, Boolean) -> Unit) {
        val manifestFile = locate("src/main/AndroidManifest.xml")
            ?: locate("app/src/main/AndroidManifest.xml")
        if (manifestFile == null) {
            check("manifest checks: AndroidManifest.xml found", false)
            return
        }
        val raw = manifestFile.readText()
        // Strip XML comments before asserting absence: this file deliberately
        // DOCUMENTS why it uses some service types and not others; a naive
        // contains() over comments would make absence/presence checks misleading.
        val m = raw.replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "")

        check("manifest: FOREGROUND_SERVICE permission declared",
            m.contains("android.permission.FOREGROUND_SERVICE\""))
        check("manifest: FOREGROUND_SERVICE_SPECIAL_USE permission declared",
            m.contains("android.permission.FOREGROUND_SERVICE_SPECIAL_USE"))
        check("manifest: PlaybackRelayForegroundService is declared",
            m.contains(".android.PlaybackRelayForegroundService"))
        check("manifest: foregroundServiceType is specialUse",
            m.contains("android:foregroundServiceType=\"specialUse\""))
        check("manifest: dataSync type is NOT used (avoids Android 15 FGS time limits)",
            !m.contains("dataSync"))
        check("manifest: PROPERTY_SPECIAL_USE_FGS_SUBTYPE present",
            m.contains("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"))
        check("manifest: special-use subtype has a real description",
            m.contains("Continuous local MediaSession observation"))
        check("manifest: no stale claim that the app has no internet",
            !raw.contains("NO internet"))
        check("manifest: RECORD_AUDIO declared for Phase 2A ambient mode",
            m.contains("android.permission.RECORD_AUDIO"))
        check("manifest: FOREGROUND_SERVICE_MICROPHONE declared",
            m.contains("android.permission.FOREGROUND_SERVICE_MICROPHONE"))
        check("manifest: INTERNET still declared (relay transport intact)",
            m.contains("android.permission.INTERNET"))
        check("phase3: obsolete Google Song Search package visibility removed",
            !m.contains("com.google.android.googlequicksearchbox") &&
                !m.contains("android.service.musicrecognition.MUSIC_RECOGNITION"))

        // All services must be unexported; only the launcher Activity is exported.
        val fgBlock = m.substringAfter(".android.PlaybackRelayForegroundService", "")
            .substringBefore("</service>", "")
        check("manifest: foreground service is NOT exported",
            fgBlock.contains("android:exported=\"false\""))
        val listenerBlock = m.substringAfter(".android.MediaNotificationListenerService", "")
            .substringBefore("</service>", "")
        check("manifest: notification listener is still NOT exported",
            listenerBlock.contains("android:exported=\"false\""))
        val ambientBlock = m.substringAfter(".android.AmbientRecognitionService", "")
            .substringBefore("</service>", "")
        check("manifest: ambient microphone service is NOT exported",
            ambientBlock.contains("android:exported=\"false\""))


        // ---- Phase 1C.1 + Phase 2A additions ----
        check("manifest(11): POST_NOTIFICATIONS declared for Android 13+",
            m.contains("android.permission.POST_NOTIFICATIONS"))
        check("manifest(12): AmbientRecognitionService declared",
            m.contains(".android.AmbientRecognitionService"))
        check("manifest(13): ambient foregroundServiceType is microphone",
            m.contains("android:foregroundServiceType=\"microphone\""))

        val activity = locate("src/main/java/com/listeningmirror/companion/android/DebugActivity.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/android/DebugActivity.kt")
        if (activity != null) {
            val s = activity.readText()
            check("activity(8): visible Activity calls ensureRunning",
                s.contains("PlaybackRelayForegroundService.ensureRunning"))
            check("activity: race-free listener-late subscription exists",
                s.contains("subscribeObservationState") && s.contains("if (observing"))
            check("activity: observes asynchronous foreground status changes",
                s.contains("KeepaliveStatus.subscribe"))
            check("activity(8): visible Activity surfaces keepalive status",
                s.contains("KeepaliveStatus.describe"))
            check("activity(11): requests POST_NOTIFICATIONS at runtime",
                s.contains("POST_NOTIFICATIONS") && s.contains("requestPermissions"))
            check("ambient activity: requests RECORD_AUDIO from visible UI",
                s.contains("Manifest.permission.RECORD_AUDIO") && s.contains("REQUEST_RECORD_AUDIO"))
            check("ambient activity: starts microphone service from visible Activity",
                s.contains("AmbientRecognitionService.startFromVisibleActivity"))
            check("phase3: Activity surfaces free Shazam/SongRec provider",
                s.contains("Phase 3 provider: free Shazam/SongRec"))
            check("phase3: obsolete Google Song Search probe UI removed",
                !s.contains("GoogleSongSearchProbe") && !s.contains("MUSIC_SEARCH"))
        } else {
            check("DebugActivity source located", false)
        }

        val status = locate("src/main/java/com/listeningmirror/companion/android/KeepaliveStatus.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/android/KeepaliveStatus.kt")
        if (status != null) {
            val s = status.readText()
            check("keepalive(9): a rejected start is recorded, not swallowed",
                s.contains("recordRejection"))
            check("keepalive(9): ACTIVE is only reported after real foreground activation",
                s.contains("markForegroundActive"))
        } else {
            check("KeepaliveStatus source located", false)
        }

        val fgs = locate("src/main/java/com/listeningmirror/companion/android/PlaybackRelayForegroundService.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/android/PlaybackRelayForegroundService.kt")
        if (fgs != null) {
            val s = fgs.readText()
            check("keepalive(9): startup rejection is captured by the service helper",
                s.contains("KeepaliveStatus.recordRejection"))
            check("keepalive: onDestroy clears ACTIVE status",
                s.contains("override fun onDestroy()") && s.contains("KeepaliveStatus.markForegroundStopped()"))
            check("keepalive: direct stopService is used instead of background STOP-start",
                s.contains("context.stopService"))
            check("keepalive(14): foreground service creates NO provider or publisher",
                !s.contains("AndroidMediaSessionProvider(") && !s.contains("RelayPublisher("))
            check("companion notification: can start ambient from explicit notification interaction",
                s.contains("PendingIntent.getForegroundService") &&
                    s.contains("AmbientRecognitionService.ACTION_START") &&
                    s.contains("Start ambient"))
        }

        val ambientService = locate("src/main/java/com/listeningmirror/companion/android/AmbientRecognitionService.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/android/AmbientRecognitionService.kt")
        if (ambientService != null) {
            val s = ambientService.readText()
            check("ambient service: startForeground uses MICROPHONE type",
                s.contains("FOREGROUND_SERVICE_TYPE_MICROPHONE"))
            check("ambient service: sticky recovery keeps an already user-started session alive",
                s.contains("return START_STICKY"))
            check("ambient service: notification exposes an explicit STOP action",
                s.contains("ACTION_STOP") && s.contains("PendingIntent.getService") && s.contains("Stop ambient"))
            check("ambient service: skips fingerprinting active device playback",
                s.contains("ObservationHub.hasPlayingDeviceMedia()"))
            check("phase3: ambient service uses Shazam client",
                s.contains("ShazamRecognitionClient()"))
            check("phase3: fast 3s then 6s recognition attempts wired",
                s.contains("SHAZAM_FAST_SAMPLE_MS") && s.contains("SHAZAM_SECOND_SAMPLE_MS"))
            check("phase3: automatic ambient path never instantiates AudD client",
                !s.contains("AudDRecognitionClient()"))
            check("phase2c: remote OFF idles recognition without stopping service",
                s.contains("REMOTE READY · ambient off") && s.contains("setRecognitionEnabled"))
            check("phase2c: remote control worker polls while service stays armed",
                s.contains("ambient-control") && s.contains("AMBIENT_CONTROL_POLL_MS"))
            check("phase2c: generation guard prevents stale recognition worker resurrection",
                s.contains("recognitionGeneration") && s.contains("generation != recognitionGeneration"))
        } else {
            check("AmbientRecognitionService source located", false)
        }

        val ambientControl = locate("src/main/java/com/listeningmirror/companion/transport/AmbientControlClient.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/transport/AmbientControlClient.kt")
        if (ambientControl != null) {
            val s = ambientControl.readText()
            check("phase2c: Companion reads and ACKs ambient control with write credential",
                s.contains("AMBIENT_CONTROL_READ_RPC") && s.contains("AMBIENT_CONTROL_ACK_RPC"))
        } else {
            check("AmbientControlClient source located", false)
        }

        val shazamClient = locate("src/main/java/com/listeningmirror/companion/ambient/ShazamRecognitionClient.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/ambient/ShazamRecognitionClient.kt")
        if (shazamClient != null) {
            val s = shazamClient.readText()
            check("phase3 Shazam client: uses keyless amp.shazam.com endpoint",
                s.contains("https://amp.shazam.com/discovery/v5/") && !s.contains("apiToken"))
            check("phase3 Shazam client: parses match offset for lyric positioning",
                s.contains("optDouble(\"offset\"") && s.contains("positionMs"))
            check("phase3 Shazam client: does not silently fall back to paid provider",
                !s.contains("AudDRecognitionClient") && !s.contains("api.audd.io"))
        } else {
            check("ShazamRecognitionClient source located", false)
        }

        val fingerprint = locate("src/main/java/com/listeningmirror/companion/ambient/ShazamFingerprint.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/ambient/ShazamFingerprint.kt")
        if (fingerprint != null) {
            val s = fingerprint.readText()
            check("phase3 fingerprint: requires 16 kHz PCM16",
                s.contains("SAMPLE_RATE_HZ = 16_000") && s.contains("PCM16"))
            check("phase3 fingerprint: emits Shazam data URI",
                s.contains("data:audio/vnd.shazam.sig;base64,"))
            check("phase3 fingerprint: includes CRC32 packet integrity",
                s.contains("CRC32()"))
        } else {
            check("ShazamFingerprint source located", false)
        }

        val auddClient = locate("src/main/java/com/listeningmirror/companion/ambient/AudDRecognitionClient.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/ambient/AudDRecognitionClient.kt")
        if (auddClient != null) {
            val s = auddClient.readText()
            check("legacy AudD client retained for manual rollback: official endpoint",
                s.contains("https://api.audd.io/"))
            check("ambient AudD client: requests spotify + apple_music metadata",
                s.contains("apple_music,spotify"))
            check("ambient AudD client: uploads a WAV multipart file",
                s.contains("audio/wav") && s.contains("filename=\\\"ambient.wav\\\""))
        } else {
            check("AudDRecognitionClient source located", false)
        }

        // Resolver must never present an uploader as canonical.
        val resolver = locate("src/main/java/com/listeningmirror/companion/logic/YouTubeMetadataResolver.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/logic/YouTubeMetadataResolver.kt")
        if (resolver != null) {
            check("resolver: YOUTUBE_UPLOADER provenance is never marked canonical",
                !resolver.readText().contains("Provenance.YOUTUBE_UPLOADER,\n                    artistIsCanonical = true"))
        }

        // --- source-level architecture assertions ---
        val listener = locate("src/main/java/com/listeningmirror/companion/android/MediaNotificationListenerService.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/android/MediaNotificationListenerService.kt")
        if (listener != null) {
            val s = listener.readText()
            check("listener: starts the foreground keepalive on connect",
                s.contains("PlaybackRelayForegroundService.ensureRunning"))
            check("listener: stops the foreground keepalive on genuine disconnect/destroy",
                s.contains("PlaybackRelayForegroundService.stop"))
            val connectBlock = s.substringAfter("override fun onListenerConnected()")
                .substringBefore("override fun onListenerDisconnected()")
            check("listener: reconnect does NOT tear down an already-active keepalive before restart",
                !connectBlock.contains("PlaybackRelayForegroundService.stop"))
            check("listener: still constructs exactly ONE provider and ONE publisher",
                Regex("AndroidMediaSessionProvider\\(").findAll(s).count() == 1 &&
                Regex("RelayPublisher\\(").findAll(s).count() == 1)
            check("listener: keepalive is NOT gated on playback state",
                !s.contains("isPlaying"))
        } else {
            check("listener source located", false)
        }

        val config = locate("src/main/java/com/listeningmirror/companion/transport/RelayConfig.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/transport/RelayConfig.kt")
        if (config != null) {
            check("transport: 20s heartbeat unchanged",
                config.readText().contains("HEARTBEAT_MS = 20_000L"))
        } else {
            check("RelayConfig source located", false)
        }

        val fg = locate("src/main/java/com/listeningmirror/companion/android/PlaybackRelayForegroundService.kt")
            ?: locate("app/src/main/java/com/listeningmirror/companion/android/PlaybackRelayForegroundService.kt")
        if (fg != null) {
            val s = fg.readText()
            check("foreground service: uses STOP_FOREGROUND_REMOVE on clean stop",
                s.contains("STOP_FOREGROUND_REMOVE"))
            check("foreground service: has an onDestroy cleanup path",
                s.contains("override fun onDestroy()") && s.contains("markForegroundStopped"))
            check("foreground service: uses a LOW importance channel",
                s.contains("IMPORTANCE_LOW"))
            check("foreground service: declares the specialUse type at startForeground",
                s.contains("FOREGROUND_SERVICE_TYPE_SPECIAL_USE"))
            check("foreground service: lifecycle is NOT gated on playback state",
                !s.contains("state.isPlaying"))
        } else {
            check("foreground service source located", false)
        }
    }
}
