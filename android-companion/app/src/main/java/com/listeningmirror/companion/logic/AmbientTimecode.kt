package com.listeningmirror.companion.logic

/** Pure parser for AudD's documented MM:SS / HH:MM:SS timecode strings. */
object AmbientTimecode {
    fun parseMs(value: String?): Long? {
        val parts = value?.trim()?.split(':') ?: return null
        if (parts.size !in 2..3) return null
        val nums = parts.map { it.toLongOrNull() ?: return null }
        if (nums.any { it < 0 }) return null
        val seconds = when (nums.size) {
            2 -> nums[0] * 60L + nums[1]
            3 -> nums[0] * 3600L + nums[1] * 60L + nums[2]
            else -> return null
        }
        if (nums.last() >= 60L) return null
        if (nums.size == 3 && nums[1] >= 60L) return null
        return seconds * 1000L
    }
}
