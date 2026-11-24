package com.listeningmirror.companion.model

/**
 * A deliberately small, collapsed view of Android's PlaybackState.state
 * IntDef. PLAYING and the clear terminal states (PAUSED/STOPPED/ERROR/NONE)
 * are kept distinct because selection logic treats them differently.
 * Everything else Android can report — BUFFERING, CONNECTING,
 * FAST_FORWARDING, REWINDING, SKIPPING_TO_* — collapses into TRANSITIONAL,
 * because the investigation's correction #3 treats all of them the same
 * way: don't flap away from a session just because it's briefly in one of
 * these, if it was already the selected session.
 */
enum class RawPlaybackState {
    PLAYING,
    PAUSED,
    STOPPED,
    ERROR,
    NONE,
    TRANSITIONAL,
}

/**
 * A pure, Android-independent snapshot of what one MediaController reported
 * at one moment. Every field here is either exactly what Android gave us
 * (the "raw" fields, kept for the debug screen) or a trivial, lossless
 * restatement of it (packageName, playbackState). No normalization,
 * sentinel-handling, or interpretation happens in this file — that's the
 * job of the logic/ package, which is what makes this shape unit-testable
 * independent of any specific Android snapshot ever being real.
 */
data class RawSessionSnapshot(
    /**
     * Opaque, unique identity for THIS MediaSession -- derived from the
     * session's own token, not from its package. A single app can legally
     * publish more than one session (Spotify's own Connect/cast handling
     * is a plausible real case), and keying selection on package name
     * would silently collapse two genuinely different sessions into one,
     * making "which one is actually playing" unanswerable. Package stays
     * available below for source mapping and display, which is what it's
     * actually appropriate for.
     */
    val sessionId: String,

    val packageName: String,

    // Collapsed state used by selection logic.
    val playbackState: RawPlaybackState,
    // The exact android.media.session.PlaybackState.STATE_* int, kept
    // only for the debug screen's "RAW PLAYBACK STATE" row — never used
    // by any decision logic, precisely so a future new STATE_* constant
    // can't silently change selection behavior without a deliberate
    // update to the mapping that produces `playbackState` above.
    val rawPlaybackStateInt: Int?,

    val artist: String?,
    val track: String?,
    val album: String?,

    val mediaId: String?,
    val mediaUri: String?,

    val artUri: String?,
    val albumArtUri: String?,
    val hasArtBitmap: Boolean,
    val hasAlbumArtBitmap: Boolean,

    // Exactly what MediaMetadata.getLong(METADATA_KEY_DURATION) returned,
    // or null if the key wasn't present at all. Not yet normalized —
    // negative-means-unknown handling happens in DurationNormalizer.
    val durationMsRaw: Long?,

    // Exactly what PlaybackState.getPosition() returned. Not yet
    // normalized — PLAYBACK_POSITION_UNKNOWN (-1) handling happens in
    // PositionNormalizer, deliberately not here.
    val positionRaw: Long?,
    // Exactly what PlaybackState.getLastPositionUpdateTime() returned.
    // 0 means "never set" per the platform's own contract.
    val lastPositionUpdateTimeMs: Long?,

    // Diagnostic only, per explicit correction #2 — never feeds into
    // CurrentListeningState or any interpolation math in this phase.
    val playbackSpeed: Float?,

    // This session's own index in the list getActiveSessions() returned,
    // i.e. Android's own priority ordering — index 0 was the OS's own top
    // pick. Used only as a tiebreaker among multiple genuinely-PLAYING
    // sessions, never as the primary selection signal.
    val osPriorityIndex: Int,
)
