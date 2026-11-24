package com.listeningmirror.companion.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import com.listeningmirror.companion.ambient.AmbientAudioRecorder
import com.listeningmirror.companion.ambient.AmbientConfig
import com.listeningmirror.companion.ambient.AmbientRecognitionResult
import com.listeningmirror.companion.ambient.AmbientStatus
import com.listeningmirror.companion.ambient.ShazamRecognitionClient
import com.listeningmirror.companion.logic.AmbientPositionAnchor
import com.listeningmirror.companion.model.CurrentListeningState
import com.listeningmirror.companion.transport.AmbientControlClient
import com.listeningmirror.companion.transport.DeviceIdentity
import com.listeningmirror.companion.transport.DeviceSecretStore
import com.listeningmirror.companion.transport.RelayConfig
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * User-armed microphone foreground service for external/ambient music.
 *
 * Phase 2C keeps this foreground service alive after a user starts it once.
 * Mirror can then remotely switch recognition ON/OFF through the existing
 * Supabase transport without reopening the APK. Remote OFF idles the mic and
 * recognition loop; it does NOT stop this service. Explicit notification/app STOP is
 * still a real stop and prevents resurrection.
 */
class AmbientRecognitionService : Service() {
    @Volatile private var serviceAlive = false
    @Volatile private var recognitionEnabled = false
    @Volatile private var recognitionGeneration = 0L

    private var recognitionWorker: Thread? = null
    private var controlWorker: Thread? = null
    private lateinit var recorder: AmbientAudioRecorder
    private lateinit var secretStore: DeviceSecretStore
    private lateinit var identity: DeviceIdentity

    @Volatile private var lastControlSequence: Long = -1L

    private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        recorder = AmbientAudioRecorder(this)
        secretStore = DeviceSecretStore(this)
        identity = DeviceIdentity(this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            stopSelf()
            return START_NOT_STICKY
        }

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            AmbientStatus.update(
                running = false,
                phase = "MICROPHONE PERMISSION MISSING",
                lastError = "RECORD_AUDIO not granted",
            )
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundCompat(enabled = true)
        serviceAlive = true

        // A real user start still behaves exactly like Phase 2B: ambient is
        // immediately ON. The control poll will reconcile to Mirror's desired
        // state as soon as a Phase 2C command exists.
        if (intent?.action == ACTION_START) {
            setRecognitionEnabled(true, "user start")
        }

        ensureControlWorker()

        // Sticky recreation keeps the already-user-armed control plane alive.
        // We intentionally do not auto-enable recognition on a null intent;
        // the server command is the source of truth after process recreation.
        return START_STICKY
    }

    @Synchronized
    private fun setRecognitionEnabled(enabled: Boolean, @Suppress("UNUSED_PARAMETER") reason: String) {
        if (enabled && recognitionEnabled && recognitionWorker?.isAlive == true) {
            updateForegroundNotification(enabled = true)
            return
        }
        recognitionGeneration += 1
        val myGeneration = recognitionGeneration
        recognitionEnabled = enabled
        if (!enabled) {
            recorder.cancel()
            recognitionWorker?.interrupt()
            recognitionWorker = null
            RelayPublisherHolder.get()?.onAmbientState(null)
            AmbientStatus.update(
                running = true,
                phase = "REMOTE READY · ambient off",
                lastError = null,
            )
            updateForegroundNotification(enabled = false)
            return
        }

        updateForegroundNotification(enabled = true)
        if (recognitionWorker?.isAlive == true) return

        AmbientStatus.update(
            running = true,
            phase = "READY · free Shazam/SongRec · smart continuous",
            usingTestToken = false,
            requestCount = 0,
            lastMatch = null,
            lastError = null,
            lastCaptureDiagnostic = null,
        )
        recognitionWorker = Thread(
            { recognitionLoop(myGeneration) },
            "ambient-recognition",
        ).apply { start() }
    }

    private fun ensureControlWorker() {
        if (controlWorker?.isAlive == true) return
        controlWorker = Thread({ controlLoop() }, "ambient-control").apply { start() }
    }

    private fun controlLoop() {
        val client = AmbientControlClient()
        while (serviceAlive && !Thread.currentThread().isInterrupted) {
            val secret = secretStore.load()
            if (secret != null) {
                val command = client.read(secret)
                if (command?.present == true && command.commandSequence != lastControlSequence) {
                    lastControlSequence = command.commandSequence
                    setRecognitionEnabled(command.desiredEnabled, "mirror remote")
                    client.ack(
                        writeSecret = secret,
                        commandSequence = command.commandSequence,
                        enabled = command.desiredEnabled,
                        deviceId = identity.deviceId,
                    )
                }
            }

            try {
                Thread.sleep(RelayConfig.AMBIENT_CONTROL_POLL_MS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                break
            }
        }
    }

    private fun recognitionLoop(generation: Long) {
        val client = ShazamRecognitionClient()
        val attempts = longArrayOf(
            AmbientConfig.SHAZAM_FAST_SAMPLE_MS,
            AmbientConfig.SHAZAM_SECOND_SAMPLE_MS,
        )

        while (serviceAlive && recognitionEnabled && generation == recognitionGeneration && !Thread.currentThread().isInterrupted) {
            val publisher = RelayPublisherHolder.get()
            if (publisher == null || !publisher.status().hasSecret) {
                AmbientStatus.update(
                    running = true,
                    phase = "WAITING · relay secret/publisher not ready",
                    usingTestToken = false,
                )
                if (!sleepRecognition(AmbientConfig.DEVICE_PLAYBACK_RECHECK_MS, generation)) break
                continue
            }

            if (ObservationHub.hasPlayingDeviceMedia()) {
                RelayPublisherHolder.get()?.onAmbientState(null)
                AmbientStatus.update(
                    running = true,
                    phase = "WAITING · active device playback has priority",
                    usingTestToken = false,
                )
                if (!sleepRecognition(AmbientConfig.DEVICE_PLAYBACK_RECHECK_MS, generation)) break
                continue
            }

            try {
                var matched = false
                var abortAttempts = false

                for (durationMs in attempts) {
                    if (!serviceAlive || !recognitionEnabled || generation != recognitionGeneration) {
                        abortAttempts = true
                        break
                    }
                    if (ObservationHub.hasPlayingDeviceMedia()) {
                        abortAttempts = true
                        break
                    }

                    AmbientStatus.update(
                        running = true,
                        phase = "LISTENING · Shazam ${(durationMs / 1000)}s sample",
                        usingTestToken = false,
                        lastError = null,
                    )
                    val captureStartedElapsedMs = SystemClock.elapsedRealtime()
                    val capture = recorder.captureWav(
                        durationMs = durationMs,
                        sampleRateHz = AmbientConfig.SHAZAM_SAMPLE_RATE_HZ,
                    )
                    if (!serviceAlive || !recognitionEnabled || generation != recognitionGeneration) {
                        abortAttempts = true
                        break
                    }

                    val diagnostic = capture.diagnostic()
                    val usable = capture.stats.isUsable(
                        AmbientConfig.MIN_RMS_DBFS,
                        AmbientConfig.MIN_PEAK_DBFS,
                    )
                    if (!usable) {
                        RelayPublisherHolder.get()?.onAmbientState(null)
                        AmbientStatus.update(
                            running = true,
                            phase = "TOO QUIET · no Shazam request sent",
                            usingTestToken = false,
                            lastCaptureDiagnostic = diagnostic,
                            lastError = null,
                        )
                        abortAttempts = true
                        break
                    }

                    val nextCount = AmbientStatus.current().requestCount + 1
                    AmbientStatus.update(
                        running = true,
                        phase = "RECOGNIZING · free Shazam/SongRec",
                        usingTestToken = false,
                        requestCount = nextCount,
                        lastCaptureDiagnostic = diagnostic,
                    )
                    val result = client.recognize(capture.pcm16Le, capture.durationMs)
                    val recognitionReceivedElapsedMs = SystemClock.elapsedRealtime()
                    if (!serviceAlive || !recognitionEnabled || generation != recognitionGeneration) {
                        abortAttempts = true
                        break
                    }

                    if (result != null) {
                        val elapsedSinceCaptureStartMs = recognitionReceivedElapsedMs - captureStartedElapsedMs
                        RelayPublisherHolder.get()?.onAmbientState(result.toState(elapsedSinceCaptureStartMs))
                        AmbientStatus.update(
                            running = true,
                            phase = "MATCH · Shazam · smart wait",
                            usingTestToken = false,
                            lastMatch = "${result.artist} — ${result.title}",
                            lastError = null,
                        )
                        matched = true
                        if (!sleepRecognition(nextRecognitionDelay(result), generation)) return
                        break
                    }
                }

                if (abortAttempts) {
                    if (!serviceAlive || !recognitionEnabled || generation != recognitionGeneration) break
                    if (ObservationHub.hasPlayingDeviceMedia()) continue
                    if (!sleepRecognition(AmbientConfig.NO_MATCH_RETRY_MS, generation)) break
                    continue
                }
                if (matched) continue

                RelayPublisherHolder.get()?.onAmbientState(null)
                AmbientStatus.update(
                    running = true,
                    phase = "NO MATCH · Shazam · retrying soon",
                    usingTestToken = false,
                    lastMatch = null,
                    lastError = null,
                )
                if (!sleepRecognition(AmbientConfig.NO_MATCH_RETRY_MS, generation)) break
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                break
            } catch (e: Exception) {
                if (!serviceAlive || !recognitionEnabled || generation != recognitionGeneration) break
                val message = (e.message ?: e.javaClass.simpleName).take(220)
                val rateLimited = message.contains("429") || message.contains("rate limit", ignoreCase = true)
                AmbientStatus.update(
                    running = true,
                    phase = if (rateLimited) "WAITING · Shazam rate limit" else "ERROR · Shazam · retrying",
                    usingTestToken = false,
                    lastError = message,
                )
                val retry = if (rateLimited) 60_000L else 15_000L
                if (!sleepRecognition(retry, generation)) break
            }
        }
    }

    private fun AmbientRecognitionResult.toState(elapsedSinceCaptureStartMs: Long): CurrentListeningState {
        return CurrentListeningState(
            source = AmbientConfig.SOURCE,
            artist = artist,
            primaryArtist = artist,
            track = title,
            album = album,
            artwork = artworkUrl,
            isPlaying = true,
            durationMs = durationMs,
            positionMs = AmbientPositionAnchor.atResponse(
                positionMs, elapsedSinceCaptureStartMs, durationMs
            ),
            externalId = externalId,
            externalUrl = externalUrl,
            confidence = null,
            capturedAt = isoFormat.format(Date()),
            controlsSupported = false,
        )
    }

    private fun nextRecognitionDelay(result: AmbientRecognitionResult): Long {
        val duration = result.durationMs
        val position = result.positionMs
        if (duration == null || position == null || duration <= position) {
            return AmbientConfig.UNKNOWN_DURATION_RETRY_MS
        }
        val remaining = duration - position
        return (remaining - AmbientConfig.BEFORE_EXPECTED_END_MS)
            .coerceIn(AmbientConfig.MIN_MATCH_RETRY_MS, AmbientConfig.MAX_MATCH_RETRY_MS)
    }

    private fun sleepRecognition(ms: Long, generation: Long): Boolean = try {
        Thread.sleep(ms)
        serviceAlive && recognitionEnabled && generation == recognitionGeneration
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        false
    }

    @Synchronized
    private fun stopEverything() {
        serviceAlive = false
        recognitionEnabled = false
        recognitionGeneration += 1
        recorder.cancel()
        recognitionWorker?.interrupt()
        controlWorker?.interrupt()
        recognitionWorker = null
        controlWorker = null
        RelayPublisherHolder.get()?.onAmbientState(null)
        AmbientStatus.update(running = false, phase = "OFF")
    }

    override fun onDestroy() {
        stopEverything()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
        else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }

    private fun startForegroundCompat(enabled: Boolean) {
        val notification = buildNotification(enabled)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateForegroundNotification(enabled: Boolean) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.notify(NOTIFICATION_ID, buildNotification(enabled))
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Ambient music recognition",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Listening Mirror ambient recognition and remote-ready control."
                setShowBadge(false)
            }
        )
    }

    private fun buildNotification(enabled: Boolean): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val openApp = PendingIntent.getActivity(
            this,
            47120,
            Intent(this, DebugActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopService = PendingIntent.getService(
            this,
            47121,
            Intent(this, AmbientRecognitionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return builder
            .setContentTitle(
                if (enabled) "Listening Mirror · ambient active"
                else "Listening Mirror · ambient remote ready"
            )
            .setContentText(
                if (enabled) "Listening for music around this phone. Control it from Mirror."
                else "Microphone is off. Ambient can be enabled from Mirror."
            )
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(openApp)
            .addAction(
                Notification.Action.Builder(
                    android.R.drawable.ic_menu_close_clear_cancel,
                    "Stop ambient service",
                    stopService,
                ).build()
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    companion object {
        const val ACTION_START = "com.listeningmirror.companion.action.START_AMBIENT"
        const val ACTION_STOP = "com.listeningmirror.companion.action.STOP_AMBIENT"

        private const val CHANNEL_ID = "lm_ambient_recognition"
        private const val NOTIFICATION_ID = 4712

        fun startFromVisibleActivity(context: Context): Boolean {
            val intent = Intent(context, AmbientRecognitionService::class.java).setAction(ACTION_START)
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
                else context.startService(intent)
                true
            } catch (e: Exception) {
                AmbientStatus.update(
                    running = false,
                    phase = "START REFUSED",
                    lastError = e.javaClass.simpleName + ": " + (e.message ?: ""),
                )
                false
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AmbientRecognitionService::class.java))
        }
    }
}
