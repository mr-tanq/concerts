package com.listeningmirror.companion.android

/**
 * Process-local diagnostic truth about the foreground keepalive.
 *
 * ACTIVE is set only by the service after startForeground() succeeds. A
 * successful startForegroundService() call is merely a request and is never
 * treated as proof. The optional UI observer lets the visible Activity update
 * when the asynchronous service start actually completes instead of showing a
 * stale status captured immediately after the request.
 */
object KeepaliveStatus {

    @Volatile private var foregroundActive = false
    @Volatile private var lastStartAttemptAt: String? = null
    @Volatile private var lastStartRejectedReason: String? = null
    @Volatile private var startAttempts = 0
    @Volatile private var uiObserver: (() -> Unit)? = null

    fun markForegroundActive() {
        foregroundActive = true
        lastStartRejectedReason = null
        notifyObserver()
    }

    fun markForegroundStopped() {
        foregroundActive = false
        notifyObserver()
    }

    fun recordAttempt(at: String) {
        startAttempts++
        lastStartAttemptAt = at
        notifyObserver()
    }

    fun recordRejection(reason: String) {
        foregroundActive = false
        lastStartRejectedReason = reason
        notifyObserver()
    }

    fun isActive(): Boolean = foregroundActive

    fun subscribe(observer: () -> Unit) {
        uiObserver = observer
        observer()
    }

    fun unsubscribe() {
        uiObserver = null
    }

    private fun notifyObserver() {
        uiObserver?.invoke()
    }

    fun describe(): String = buildString {
        append("Foreground keepalive: ").append(if (foregroundActive) "ACTIVE" else "NOT ACTIVE").append('\n')
        append("  start attempts: ").append(startAttempts).append('\n')
        append("  last attempt:   ").append(lastStartAttemptAt ?: "never").append('\n')
        if (lastStartRejectedReason != null) {
            append("  REJECTED BY ANDROID: ").append(lastStartRejectedReason).append('\n')
            append("  (background start refused; a visible Companion screen can retry it)")
        }
    }
}
