package com.listeningmirror.companion.android

/**
 * The keepalive lifecycle expressed as a pure state machine, so the ORDER and
 * IDEMPOTENCE of the transitions can be unit-tested without Android.
 *
 * It deliberately encodes the one rule that matters most here: the keepalive
 * follows the LISTENER CONNECTION, never playback state. Tying it to
 * isPlaying would recreate on Android exactly the disappear-on-pause class of
 * bug that mirror.js's MAX_TOLERATED_MISSES exists to prevent on the web.
 *
 * This models the decision logic only. Whether Samsung actually honours a
 * foreground service is a real-device question no unit test can answer.
 */
object KeepaliveLifecycle {

    enum class Event { LISTENER_CONNECTED, LISTENER_DISCONNECTED, DESTROYED,
                       PLAYBACK_STARTED, PLAYBACK_PAUSED, SELECTION_BECAME_NULL,
                       TRACK_CHANGED, SOURCE_SWITCHED }

    data class State(val listenerConnected: Boolean = false) {
        /** The keepalive runs exactly when the listener is connected. */
        val keepaliveRunning: Boolean get() = listenerConnected
    }

    fun next(state: State, event: Event): State = when (event) {
        Event.LISTENER_CONNECTED -> State(listenerConnected = true)
        Event.LISTENER_DISCONNECTED, Event.DESTROYED -> State(listenerConnected = false)
        // Every playback-related event is deliberately inert.
        Event.PLAYBACK_STARTED, Event.PLAYBACK_PAUSED, Event.SELECTION_BECAME_NULL,
        Event.TRACK_CHANGED, Event.SOURCE_SWITCHED -> state
    }
}
