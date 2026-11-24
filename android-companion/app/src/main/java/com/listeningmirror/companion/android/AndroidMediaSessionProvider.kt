package com.listeningmirror.companion.android

import android.content.ComponentName
import android.content.Context
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.SystemClock
import com.listeningmirror.companion.logic.ActiveSessionSelector
import com.listeningmirror.companion.logic.MetadataCompleteness
import com.listeningmirror.companion.logic.SourceMapper
import com.listeningmirror.companion.logic.StateNormalizer
import com.listeningmirror.companion.model.CurrentListeningState
import com.listeningmirror.companion.model.RawPlaybackState
import com.listeningmirror.companion.model.RawSessionSnapshot
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Everything the debug screen needs for one refresh: the normalized state
 * for the selected session (or null when there's no active device
 * playback), the raw snapshot behind it (for the raw diagnostic rows), and
 * every visible session so the real behavior of Spotify/YouTube can be
 * observed side by side rather than only seeing the final answer.
 */
data class ProviderSnapshot(
    val selectedState: CurrentListeningState?,
    val selectedRaw: RawSessionSnapshot?,
    val metadataCompleteForLyrics: Boolean,
    val allSessions: List<RawSessionSnapshot>,
    val selectedSessionId: String?,
)

/**
 * Observes Android MediaSessions and produces normalized listening state.
 *
 * Event-driven by design, matching the web-side provider contract's shape
 * (start with an onSnapshot callback, stop cleanly) — there is deliberately
 * no polling loop here. Updates fire from:
 *   - MediaSessionManager.OnActiveSessionsChangedListener (a session
 *     appears/disappears entirely)
 *   - MediaController.Callback.onMetadataChanged (track change)
 *   - MediaController.Callback.onPlaybackStateChanged (play/pause/seek —
 *     seek included, because a seek updates position + its update
 *     timestamp, which is exactly a new anchor)
 *   - MediaController.Callback.onSessionDestroyed
 *
 * Named AndroidMediaSessionProvider (not "AndroidProvider") so a future
 * AndroidAmbientProvider can sit beside it without either one needing to
 * be restructured, per the architecture recommendation.
 */
class AndroidMediaSessionProvider(private val context: Context) {

    private var sessionManager: MediaSessionManager? = null
    private var listenerComponent: ComponentName? = null
    private var onSnapshot: ((ProviderSnapshot) -> Unit)? = null

    // Controllers we've attached a callback to, so they can be cleanly
    // detached — without this, callbacks leak across session list changes.
    private val watched = mutableMapOf<MediaController, MediaController.Callback>()

    /**
     * Stable, opaque sessionId per distinct MediaSession, keyed by the
     * session's own Token.
     *
     * MediaSession.Token is the platform's actual identity contract for a
     * session -- it implements meaningful equals/hashCode, which is what
     * makes it usable as a map key. Its toString() is NOT part of that
     * contract: it's a debug representation with no stability or
     * uniqueness guarantee, so deriving identity from it would be relying
     * on undocumented behavior for something selection correctness
     * depends on.
     *
     * Ids are generated rather than derived so nothing downstream can
     * accidentally start parsing meaning out of them, and are stable for
     * the lifetime of one observation session -- cleared in stop(),
     * alongside selection stickiness, since both are only meaningful
     * within a single continuous observation session.
     */
    private val sessionIds = mutableMapOf<MediaSession.Token, String>()
    private var nextSessionIdSuffix = 1

    // The last SESSION we selected. Feeds ActiveSessionSelector's
    // transitional-stickiness rule; deliberately the ONLY piece of
    // cross-call state this class keeps.
    //
    // Reset in stop() -- stickiness is meaningful only WITHIN one
    // continuous observation session. Carrying it across a genuine
    // shutdown/restart would let a session selected before the listener
    // disconnected silently win a stickiness check after it reconnected,
    // which is a different (and false) claim about continuity.
    private var previouslySelectedSessionId: String? = null

    private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    private val activeSessionsListener =
        MediaSessionManager.OnActiveSessionsChangedListener { controllers ->
            rewatch(controllers ?: emptyList())
            emit()
        }

    fun start(onSnapshot: (ProviderSnapshot) -> Unit) {
        stop()
        this.onSnapshot = onSnapshot

        val manager = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
        sessionManager = manager
        val component = ComponentName(context, MediaNotificationListenerService::class.java)
        listenerComponent = component

        // Both calls throw SecurityException until Notification Access is
        // granted. That's the expected pre-grant state, not a crash case —
        // the UI checks for the grant before calling start(), and this
        // guard means an unexpected revocation mid-session degrades to
        // "no sessions" rather than taking the app down.
        try {
            manager.addOnActiveSessionsChangedListener(activeSessionsListener, component)
            rewatch(manager.getActiveSessions(component))
        } catch (e: SecurityException) {
            watched.clear()
        }
        emit()
    }

    fun stop() {
        sessionManager?.let { manager ->
            try {
                manager.removeOnActiveSessionsChangedListener(activeSessionsListener)
            } catch (e: SecurityException) {
                // Nothing to remove if access was already revoked.
            }
        }
        watched.forEach { (controller, callback) -> controller.unregisterCallback(callback) }
        watched.clear()
        sessionManager = null
        listenerComponent = null
        onSnapshot = null
        previouslySelectedSessionId = null
        sessionIds.clear()
        nextSessionIdSuffix = 1
    }

    /** Refresh which controllers we hold callbacks on. */
    private fun rewatch(controllers: List<MediaController>) {
        watched.forEach { (controller, callback) -> controller.unregisterCallback(callback) }
        watched.clear()
        controllers.forEach { controller ->
            val callback = object : MediaController.Callback() {
                override fun onMetadataChanged(metadata: MediaMetadata?) = emit()
                override fun onPlaybackStateChanged(state: PlaybackState?) = emit()
                override fun onSessionDestroyed() {
                    refreshAndEmit()
                }
            }
            controller.registerCallback(callback)
            watched[controller] = callback
        }
    }

    private fun refreshAndEmit() {
        val manager = sessionManager
        val component = listenerComponent
        if (manager != null && component != null) {
            try {
                rewatch(manager.getActiveSessions(component))
            } catch (e: SecurityException) {
                watched.clear()
            }
        }
        emit()
    }

    private fun emit() {
        val callback = onSnapshot ?: return
        val snapshots = watched.keys.mapIndexed { index, controller ->
            snapshotOf(controller, index)
        }

        val selectedSessionId = ActiveSessionSelector.select(snapshots, previouslySelectedSessionId)
        previouslySelectedSessionId = selectedSessionId

        val selectedRaw = snapshots.find { it.sessionId == selectedSessionId }
        // Both clocks read at the same instant, deliberately: capturedAt is
        // what the state CLAIMS its position refers to, and
        // elapsedRealtimeNow is what makes that claim actually true.
        val capturedAt = isoFormat.format(Date())
        val elapsedRealtimeNow = SystemClock.elapsedRealtime()
        val selectedState = selectedRaw?.let {
            StateNormalizer.normalize(it, capturedAt, elapsedRealtimeNow)
        }

        callback(
            ProviderSnapshot(
                selectedState = selectedState,
                selectedRaw = selectedRaw,
                metadataCompleteForLyrics = MetadataCompleteness.isCompleteForLyrics(
                    selectedState?.artist, selectedState?.track
                ),
                allSessions = snapshots,
                selectedSessionId = selectedSessionId,
            )
        )
    }

    /**
     * Reads one MediaController into a pure RawSessionSnapshot. This is the
     * ONLY place in the codebase that touches android.media.* types for
     * playback data — everything downstream operates on the pure model,
     * which is what makes the selection/normalization logic unit-testable
     * without an emulator.
     */
    private fun snapshotOf(controller: MediaController, osPriorityIndex: Int): RawSessionSnapshot {
        val metadata = controller.metadata
        val playback = controller.playbackState

        return RawSessionSnapshot(
            sessionId = sessionIdFor(controller.sessionToken),
            packageName = controller.packageName,
            playbackState = mapState(playback?.state),
            rawPlaybackStateInt = playback?.state,
            artist = metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST),
            track = metadata?.getString(MediaMetadata.METADATA_KEY_TITLE),
            album = metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM),
            mediaId = metadata?.getString(MediaMetadata.METADATA_KEY_MEDIA_ID),
            mediaUri = metadata?.getString(MediaMetadata.METADATA_KEY_MEDIA_URI),
            artUri = metadata?.getString(MediaMetadata.METADATA_KEY_ART_URI),
            albumArtUri = metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI),
            // Only inspected and reported for now — no artwork transport
            // is being built in this phase.
            hasArtBitmap = metadata?.getBitmap(MediaMetadata.METADATA_KEY_ART) != null,
            hasAlbumArtBitmap = metadata?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) != null,
            // containsKey distinguishes "the app didn't set a duration at
            // all" from "the app set it to 0" — getLong() returns 0 for
            // both, and collapsing them would invent a duration.
            durationMsRaw = if (metadata?.containsKey(MediaMetadata.METADATA_KEY_DURATION) == true) {
                metadata.getLong(MediaMetadata.METADATA_KEY_DURATION)
            } else null,
            positionRaw = playback?.position,
            lastPositionUpdateTimeMs = playback?.lastPositionUpdateTime,
            playbackSpeed = playback?.playbackSpeed,
            osPriorityIndex = osPriorityIndex,
        )
    }

    /**
     * Looks up (or assigns) this token's opaque sessionId. Relies on
     * MediaSession.Token's own equals/hashCode -- two MediaController
     * objects for the same underlying session yield equal tokens and
     * therefore the same id, while two genuinely different sessions from
     * the same app get different ids.
     */
    private fun sessionIdFor(token: MediaSession.Token): String =
        sessionIds.getOrPut(token) { "session-" + (nextSessionIdSuffix++) }

    /**
     * Collapses Android's PlaybackState.STATE_* into the small enum the
     * selection logic reasons about. Every buffering/connecting/seeking/
     * skipping state maps to TRANSITIONAL, which is what gives
     * ActiveSessionSelector its anti-flapping behavior.
     */
    private fun mapState(state: Int?): RawPlaybackState = when (state) {
        PlaybackState.STATE_PLAYING -> RawPlaybackState.PLAYING
        PlaybackState.STATE_PAUSED -> RawPlaybackState.PAUSED
        PlaybackState.STATE_STOPPED -> RawPlaybackState.STOPPED
        PlaybackState.STATE_ERROR -> RawPlaybackState.ERROR
        PlaybackState.STATE_BUFFERING,
        PlaybackState.STATE_CONNECTING,
        PlaybackState.STATE_FAST_FORWARDING,
        PlaybackState.STATE_REWINDING,
        PlaybackState.STATE_SKIPPING_TO_NEXT,
        PlaybackState.STATE_SKIPPING_TO_PREVIOUS,
        PlaybackState.STATE_SKIPPING_TO_QUEUE_ITEM -> RawPlaybackState.TRANSITIONAL
        else -> RawPlaybackState.NONE
    }

    companion object {
        /** Whether Notification Access has been granted to this app. */
        fun hasNotificationAccess(context: Context): Boolean {
            val enabled = android.provider.Settings.Secure.getString(
                context.contentResolver, "enabled_notification_listeners"
            ) ?: return false
            return enabled.split(":").any {
                ComponentName.unflattenFromString(it)?.packageName == context.packageName
            }
        }

        fun sourceForPackage(packageName: String): String = SourceMapper.sourceFor(packageName)
    }
}
