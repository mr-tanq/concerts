package com.listeningmirror.companion.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Foreground process keepalive for the NotificationListener-owned playback
 * observer and relay heartbeat. It owns no provider/publisher logic itself.
 *
 * Its lifetime follows Notification Access/listener connectivity, NOT
 * isPlaying: pause, a temporary null selection, track changes and source
 * switches must not stop it.
 */
class PlaybackRelayForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // If Android is trying to restore a sticky service into a freshly
        // recreated process before the NotificationListener/publisher exists,
        // do not advertise playback detection that is not actually running.
        if (intent == null && RelayPublisherHolder.get() == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundCompat()
        // This is the ONLY success point: the async start request itself is
        // not sufficient evidence that foreground promotion happened.
        KeepaliveStatus.markForegroundActive()
        return START_STICKY
    }

    override fun onDestroy() {
        // Covers explicit stopService(), system-driven destruction, and any
        // path that does not go through a custom stop action. This prevents
        // the debug UI from retaining a stale ACTIVE flag.
        removeForegroundNotification()
        KeepaliveStatus.markForegroundStopped()
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun removeForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Playback detection",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shown while Listening Mirror is observing media playback."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val openApp = PendingIntent.getActivity(
            this,
            47110,
            Intent(this, DebugActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Android 14+ explicitly allows a while-in-use microphone FGS to be
        // started from an explicit user interaction with a notification.
        // This is the everyday path: no need to reopen the Companion screen.
        val startAmbient = PendingIntent.getForegroundService(
            this,
            47111,
            Intent(this, AmbientRecognitionService::class.java)
                .setAction(AmbientRecognitionService.ACTION_START),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return builder
            .setContentTitle("Listening Mirror · playback detection active")
            .setContentText("Media sessions are being observed. Ambient can be started here.")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openApp)
            .addAction(
                Notification.Action.Builder(
                    android.R.drawable.ic_btn_speak_now,
                    "Start ambient",
                    startAmbient,
                ).build()
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "lm_playback_relay"
        private const val NOTIFICATION_ID = 4711

        /**
         * Idempotent request to ensure the single foreground service is up.
         * Returns false when Android refuses the start request. ACTIVE is not
         * set here; the service sets it only after startForeground() succeeds.
         */
        fun ensureRunning(context: Context): Boolean {
            KeepaliveStatus.recordAttempt(
                java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
                    .format(java.util.Date())
            )
            val intent = Intent(context, PlaybackRelayForegroundService::class.java)
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                true
            } catch (e: Exception) {
                KeepaliveStatus.recordRejection(
                    e.javaClass.simpleName + ": " + (e.message ?: "start refused")
                )
                false
            }
        }

        /**
         * Directly stop the running service rather than starting a background
         * service merely to deliver a STOP action. onDestroy() performs the
         * notification/status cleanup and this call is idempotent.
         */
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, PlaybackRelayForegroundService::class.java))
            } catch (_: Exception) {
                KeepaliveStatus.markForegroundStopped()
            }
        }
    }
}
