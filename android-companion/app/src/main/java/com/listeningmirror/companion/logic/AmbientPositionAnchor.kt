package com.listeningmirror.companion.logic

/**
 * Re-anchors AudD's song timecode to the instant the recognition response
 * becomes available. AudD timecode describes where the submitted fragment
 * lines up inside the original recording; for live capture, that fragment
 * started in the past. Advancing by the monotonic elapsed time since capture
 * began prevents lyrics/progress from being one capture-window behind.
 */
object AmbientPositionAnchor {
    fun atResponse(
        timecodeMs: Long?,
        elapsedSinceCaptureStartMs: Long,
        durationMs: Long?,
    ): Long? {
        val anchor = timecodeMs ?: return null
        val elapsed = elapsedSinceCaptureStartMs.coerceAtLeast(0L)
        var value = anchor + elapsed
        if (durationMs != null && durationMs > 0L && value > durationMs) value = durationMs
        return value.coerceAtLeast(0L)
    }
}
