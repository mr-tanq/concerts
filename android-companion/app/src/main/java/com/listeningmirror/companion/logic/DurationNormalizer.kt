package com.listeningmirror.companion.logic

/**
 * MediaMetadata's own documented contract: "A negative duration indicates
 * that the duration is unknown (or infinite)." Normalizes that into null
 * rather than passing a negative number downstream. 0 is left as a valid
 * (if unusual) value — this file doesn't invent a special case for it,
 * since nothing in the platform contract calls 0 out as meaning "unknown"
 * the way it explicitly does for negative values.
 */
object DurationNormalizer {
    fun normalize(durationRaw: Long?): Long? {
        if (durationRaw == null) return null
        if (durationRaw < 0) return null
        return durationRaw
    }
}
