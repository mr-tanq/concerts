package com.listeningmirror.companion.transport

import com.listeningmirror.companion.model.CurrentListeningState

/**
 * Heartbeat position re-anchoring.
 *
 * The problem this exists to solve: CurrentListeningState.positionMs is
 * normalized to the instant it was CAPTURED. Republishing that cached state
 * unchanged as a heartbeat gives it a fresh server received_at while its
 * position silently ages -- so the web's compensation would treat a
 * 20-second-old anchor as current, compounding the error instead of
 * correcting it.
 *
 * Pure function of (state, monotonic delta) so it is fully unit-testable
 * with no Android runtime. PositionNormalizer and the MediaSession
 * observation layer are deliberately untouched by any of this -- position
 * re-anchoring is a transport concern only.
 */
object PositionReanchor {

    /**
     * @param state the last state received from the observation layer
     * @param elapsedDeltaMs SystemClock.elapsedRealtime() now MINUS the
     *        value recorded when that state arrived. Monotonic by
     *        construction: immune to wall-clock jumps and NTP corrections,
     *        which is exactly why elapsedRealtime is the right basis.
     * @param capturedAtIso the heartbeat instant
     */
    fun reanchor(
        state: CurrentListeningState,
        elapsedDeltaMs: Long,
        capturedAtIso: String,
    ): CurrentListeningState {
        // Not playing: the position genuinely has not moved, so it is still
        // correct AS OF the heartbeat instant -- refresh capturedAt, advance
        // nothing.
        if (!state.isPlaying) return state.copy(capturedAt = capturedAtIso)

        // Unknown stays unknown. The transport layer must never be the place
        // that invents a number the observation layer refused to invent.
        val anchor = state.positionMs ?: return state.copy(capturedAt = capturedAtIso)

        if (elapsedDeltaMs <= 0) return state.copy(capturedAt = capturedAtIso)

        var advanced = anchor + elapsedDeltaMs
        // Clamp to duration when known. Without this, a track that ended
        // while Android missed the update would advance past its own length
        // indefinitely. A position pinned at duration is also a useful
        // signal later ("this probably ended").
        val duration = state.durationMs
        if (duration != null && duration > 0 && advanced > duration) advanced = duration

        return state.copy(positionMs = advanced, capturedAt = capturedAtIso)
    }
}
