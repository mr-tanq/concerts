package com.listeningmirror.companion.ambient

/** Small in-process status surface for the debug Activity. */
object AmbientStatus {
    data class Snapshot(
        val running: Boolean,
        val phase: String,
        val usingTestToken: Boolean,
        val requestCount: Int,
        val lastMatch: String?,
        val lastError: String?,
        val lastCaptureDiagnostic: String?,
    )

    @Volatile private var snapshot = Snapshot(false, "OFF", true, 0, null, null, null)
    @Volatile private var observer: ((Snapshot) -> Unit)? = null

    fun current(): Snapshot = snapshot
    fun isRunning(): Boolean = snapshot.running

    @Synchronized
    fun update(
        running: Boolean = snapshot.running,
        phase: String = snapshot.phase,
        usingTestToken: Boolean = snapshot.usingTestToken,
        requestCount: Int = snapshot.requestCount,
        lastMatch: String? = snapshot.lastMatch,
        lastError: String? = snapshot.lastError,
        lastCaptureDiagnostic: String? = snapshot.lastCaptureDiagnostic,
    ) {
        snapshot = Snapshot(running, phase, usingTestToken, requestCount, lastMatch, lastError, lastCaptureDiagnostic)
        observer?.invoke(snapshot)
    }

    fun subscribe(callback: (Snapshot) -> Unit) {
        observer = callback
        callback(snapshot)
    }

    fun unsubscribe() { observer = null }
}
