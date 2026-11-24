package com.listeningmirror.companion.android

/**
 * In-process seam between the long-lived NotificationListener-owned
 * MediaSession provider and the short-lived debug UI.
 *
 * Snapshot observation and provider-lifecycle observation are deliberately
 * separate. The latter is important for Android 12+: a visible Activity may
 * resume BEFORE NotificationListenerService finishes connecting. When the
 * provider attaches a moment later, the Activity gets a one-shot lifecycle
 * signal and can retry the foreground-service start from a user-visible
 * context without polling and without requiring the user to reopen the app.
 */
object ObservationHub {

    @Volatile private var latest: ProviderSnapshot? = null
    @Volatile private var uiObserver: ((ProviderSnapshot) -> Unit)? = null
    @Volatile private var observationObserver: ((Boolean) -> Unit)? = null
    @Volatile private var provider: AndroidMediaSessionProvider? = null

    /** Called by the listener service when observation starts. */
    fun attachProvider(provider: AndroidMediaSessionProvider) {
        this.provider = provider
        observationObserver?.invoke(true)
    }

    /** Called when observation genuinely ends. */
    fun detachProvider() {
        this.provider = null
        this.latest = null
        observationObserver?.invoke(false)
        uiObserver?.invoke(
            ProviderSnapshot(
                selectedState = null,
                selectedRaw = null,
                metadataCompleteForLyrics = false,
                allSessions = emptyList(),
                selectedSessionId = null,
            )
        )
    }

    /** Called by the provider on every real Android event. */
    fun publish(snapshot: ProviderSnapshot) {
        latest = snapshot
        uiObserver?.invoke(snapshot)
    }

    fun isObserving(): Boolean = provider != null

    /** True only for an actively playing Android MediaSession. Ambient mode
     * uses this to avoid paying to fingerprint audio we already know. */
    fun hasPlayingDeviceMedia(): Boolean = latest?.selectedState?.isPlaying == true

    /** Subscribe to snapshots; immediately replay the latest one if present. */
    fun subscribe(observer: (ProviderSnapshot) -> Unit) {
        uiObserver = observer
        latest?.let(observer)
    }

    fun unsubscribe() {
        uiObserver = null
    }

    /**
     * Subscribe to provider attachment state. Immediate replay makes this
     * race-free whether the Activity or listener connects first.
     */
    fun subscribeObservationState(observer: (Boolean) -> Unit) {
        observationObserver = observer
        observer(isObserving())
    }

    fun unsubscribeObservationState() {
        observationObserver = null
    }
}
