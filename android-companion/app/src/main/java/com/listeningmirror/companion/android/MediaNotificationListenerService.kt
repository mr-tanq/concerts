package com.listeningmirror.companion.android

import android.service.notification.NotificationListenerService
import com.listeningmirror.companion.transport.RelayPublisher

/**
 * Notification Access gate and long-lived owner of MediaSession observation.
 * It never reads notification content.
 */
class MediaNotificationListenerService : NotificationListenerService() {

    private var provider: AndroidMediaSessionProvider? = null
    private var publisher: RelayPublisher? = null

    override fun onListenerConnected() {
        super.onListenerConnected()

        // A reconnect must replace provider/publisher exactly once, but MUST
        // NOT tear down an already-working foreground keepalive first. Doing
        // so would immediately force a background restart that Android 12+
        // may reject, recreating the real Samsung startup failure.
        teardownObservation(stopKeepalive = false)

        // Best-effort background attempt. If Android rejects it, the visible
        // DebugActivity has a race-free ObservationHub lifecycle subscription
        // and retries as soon as this provider attaches.
        PlaybackRelayForegroundService.ensureRunning(applicationContext)

        val p = AndroidMediaSessionProvider(applicationContext)
        provider = p
        val pub = RelayPublisher(applicationContext)
        publisher = pub
        RelayPublisherHolder.set(pub)
        ObservationHub.attachProvider(p)
        pub.start()
        p.start { snapshot ->
            ObservationHub.publish(snapshot)
            pub.onSnapshot(snapshot)
        }
    }

    override fun onListenerDisconnected() {
        teardownObservation(stopKeepalive = true)
        super.onListenerDisconnected()
    }

    private fun teardownObservation(stopKeepalive: Boolean) {
        provider?.stop()
        provider = null
        publisher?.stop()
        publisher = null
        RelayPublisherHolder.set(null)
        ObservationHub.detachProvider()
        if (stopKeepalive) {
            PlaybackRelayForegroundService.stop(applicationContext)
        }
    }

    override fun onDestroy() {
        teardownObservation(stopKeepalive = true)
        super.onDestroy()
    }
}
