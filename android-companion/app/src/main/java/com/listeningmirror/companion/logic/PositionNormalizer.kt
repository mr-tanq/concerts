package com.listeningmirror.companion.logic

import com.listeningmirror.companion.model.RawPlaybackState

/**
 * Turns Android's raw playback position into a trustworthy positionMs, or
 * null when it isn't trustworthy. Never invents a position.
 *
 * Two distinct "this isn't real" signals from the platform:
 *   - PlaybackState.PLAYBACK_POSITION_UNKNOWN (-1) is Android's own
 *     explicit sentinel for "no position".
 *   - getLastPositionUpdateTime() == 0 means the position was never
 *     actually set, per the platform's documented contract -- a position
 *     number with no real update timestamp behind it is not a trustworthy
 *     anchor no matter what the number itself says.
 *
 * 0 is a fully valid real position (a track that just started) and must
 * never be confused with either of the above.
 *
 * SEMANTICS (this is the part that matters): Android's raw position
 * belongs to `lastPositionUpdateTime`, NOT to the moment we happen to read
 * it. Handing the raw number upward while stamping capturedAt with "now"
 * would silently claim two different instants are the same one. So while
 * PLAYING, the anchor is advanced by the realtime elapsed since that
 * update, making the returned value mean "position as of capturedAt" --
 * which is what the field is supposed to mean.
 *
 * Playback speed is deliberately NOT applied: this MVP supports 1.0x
 * playback only, per explicit scope. The raw speed is still surfaced on
 * the debug screen for diagnosis, but no product behavior depends on it.
 */
object PositionNormalizer {
    // android.media.session.PlaybackState.PLAYBACK_POSITION_UNKNOWN
    const val PLAYBACK_POSITION_UNKNOWN = -1L

    /**
     * The raw anchor, validated but NOT advanced. Kept separate so the
     * debug screen can show raw and normalized side by side, and so the
     * validity rules live in exactly one place.
     */
    fun validAnchorOrNull(positionRaw: Long?, lastPositionUpdateTimeMs: Long?): Long? {
        if (positionRaw == null) return null
        if (positionRaw == PLAYBACK_POSITION_UNKNOWN) return null
        if (positionRaw < 0) return null // any other negative is equally untrustworthy
        if (lastPositionUpdateTimeMs == null || lastPositionUpdateTimeMs == 0L) return null
        return positionRaw
    }

    /**
     * Position as of `elapsedRealtimeNowMs`, or null when there's no
     * trustworthy anchor to compute it from.
     *
     * @param elapsedRealtimeNowMs SystemClock.elapsedRealtime() at capture
     *        time -- the same clock base getLastPositionUpdateTime() uses.
     *        Passed in rather than read here so this stays a pure function.
     */
    fun normalizedNow(
        positionRaw: Long?,
        lastPositionUpdateTimeMs: Long?,
        state: RawPlaybackState,
        elapsedRealtimeNowMs: Long,
    ): Long? {
        val anchor = validAnchorOrNull(positionRaw, lastPositionUpdateTimeMs) ?: return null
        if (state != RawPlaybackState.PLAYING) return anchor // paused/other: frozen at its anchor

        val elapsed = elapsedRealtimeNowMs - lastPositionUpdateTimeMs!!
        // A negative elapsed means the update timestamp is in the future
        // relative to our clock reading -- nonsensical, so don't run time
        // backwards; fall back to the unadvanced anchor rather than
        // producing a position earlier than the one Android reported.
        if (elapsed <= 0) return anchor
        return anchor + elapsed
    }
}
