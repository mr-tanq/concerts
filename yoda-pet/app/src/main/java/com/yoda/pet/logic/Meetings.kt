package com.yoda.pet.logic

/** One calendar occurrence, as read from CalendarContract.Instances. */
data class CalendarEvent(
    val eventId: Long,
    val begin: Long,
    val title: String?,
    val location: String?,
    val allDay: Boolean,
    val canceled: Boolean,
    val declined: Boolean,
) {
    val key: String get() = "$eventId@$begin"
}

object Meetings {
    const val LEAD_MS = 5 * 60_000L
    /** If the phone was asleep at the 5-minute mark, still mention a meeting that just started. */
    const val GRACE_MS = 5 * 60_000L

    /**
     * Meetings Yoda should announce now: they start within the next five
     * minutes (or started under five minutes ago, e.g. the screen was off), aren't all-day, cancelled or declined,
     * and haven't been announced before. Soonest first.
     */
    fun due(events: List<CalendarEvent>, now: Long, announced: Set<String>): List<CalendarEvent> =
        events.asSequence()
            .filter { !it.allDay && !it.canceled && !it.declined }
            .filter { it.begin - now > -GRACE_MS && it.begin - now <= LEAD_MS }
            .filter { it.key !in announced }
            .distinctBy { it.key }
            .sortedBy { it.begin }
            .toList()

    fun minutesUntil(begin: Long, now: Long): Int =
        ((begin - now + 59_999) / 60_000).toInt().coerceAtLeast(0)

    fun whenText(begin: Long, now: Long, clock: String): String {
        if (begin <= now) {
            val ago = ((now - begin) / 60_000).toInt()
            return if (ago < 1) "Starting now ($clock)" else "Started $ago min ago ($clock)"
        }
        val mins = minutesUntil(begin, now)
        return if (mins <= 1) "Starting in about a minute ($clock)" else "Starts in $mins min, at $clock"
    }

    fun displayTitle(title: String?): String =
        title?.trim()?.takeIf { it.isNotEmpty() } ?: "(no title)"
}
