package com.listeningmirror.companion.logic

import java.time.LocalDate
import java.time.LocalTime

/**
 * Concert-day reminders: which of your concerts happen today, and what the
 * notification says. Pure Kotlin (no Android imports) so it is unit-tested;
 * fetching the concerts and posting the notification live in
 * android/ConcertReminders.kt.
 *
 * Only concerts with a ticket bought get a reminder — "Going → Interested"
 * holds dozens of maybes, and a reminder for each would be noise.
 */

/** One act in the evening's running order. `time` is "HH:mm" or null (TBA). */
data class ReminderAct(val name: String, val time: String?)

/** The parts of a planned concert a reminder needs. Dates are "yyyy-MM-dd". */
data class ReminderConcert(
    val id: String,
    val title: String,
    val date: String,
    val endDate: String?,
    val venue: String?,
    val city: String?,
    val ticketBought: Boolean,
    val doors: String?,
    val main: ReminderAct?,
    val support: List<ReminderAct>,
)

data class Reminder(
    /** Stable per concert per day, so each reminder is posted once. */
    val key: String,
    val concertId: String,
    val title: String,
    /** One line for the collapsed notification. */
    val text: String,
    /** The running order, for the expanded notification. */
    val details: String,
)

object ConcertReminder {

    /** Reminders go out from this time of day (local), not at midnight. */
    val SEND_FROM: LocalTime = LocalTime.of(9, 0)

    private val NO_SUPPORT = Regex(
        "^(geen(?: voorprogramma| support(?: act)?)?|no support(?: act)?|none)$",
        RegexOption.IGNORE_CASE,
    )
    private val CLOCK = Regex("^([01]?\\d|2[0-3])[:.]([0-5]\\d)$")

    /** The reminders that should be posted now and haven't been yet. */
    fun due(
        concerts: List<ReminderConcert>,
        today: LocalDate,
        now: LocalTime,
        alreadySent: Set<String>,
    ): List<Reminder> {
        if (now.isBefore(SEND_FROM)) return emptyList()
        return concerts
            .filter { it.ticketBought && isOn(it, today) }
            .sortedBy { startClock(it) ?: "99:99" }
            .map { build(it, today) }
            .filter { it.key !in alreadySent }
    }

    /** True when the concert (or a day of a multi-day festival) is today. */
    fun isOn(c: ReminderConcert, today: LocalDate): Boolean {
        val start = parseDate(c.date) ?: return false
        val end = c.endDate?.let(::parseDate) ?: start
        return !today.isBefore(start) && !today.isAfter(end)
    }

    fun build(c: ReminderConcert, today: LocalDate): Reminder {
        val acts = runningOrder(c)
        val mainTime = clock(c.main?.time)
        val evening = mainTime == null || mainTime >= "17:00"
        val title = "${c.title} ${if (evening) "tonight" else "today"}"

        val place = listOfNotNull(c.venue?.takeIf { it.isNotBlank() }, c.city?.takeIf { it.isNotBlank() })
            .distinctBy { it.lowercase() }
            .joinToString(", ")
        val parts = mutableListOf<String>()
        clock(c.doors)?.let { parts += "Doors $it" }
        if (mainTime != null) parts += "${c.main?.name ?: c.title} $mainTime"
        if (place.isNotEmpty()) parts += place
        val text = parts.joinToString(" · ").ifEmpty { "Have a great night." }

        val details = buildList {
            clock(c.doors)?.let { add("$it  Doors") }
            for (act in acts) add("${clock(act.time) ?: "TBA  "}  ${act.name}")
            if (place.isNotEmpty()) add(place)
        }.joinToString("\n").ifEmpty { text }

        return Reminder(
            key = "${c.id}@$today",
            concertId = c.id,
            title = title,
            text = text,
            details = details,
        )
    }

    /** Supports then the main act, by time; "Geen"-style placeholders dropped. */
    fun runningOrder(c: ReminderConcert): List<ReminderAct> {
        val support = c.support.filter { it.name.isNotBlank() && !NO_SUPPORT.matches(it.name.trim()) }
        val all = support + listOfNotNull(c.main)
        return all.sortedBy { clock(it.time) ?: "99:99" }
    }

    private fun startClock(c: ReminderConcert): String? =
        (listOfNotNull(clock(c.doors), clock(c.main?.time)) + c.support.mapNotNull { clock(it.time) }).minOrNull()

    /** "9.30" / "21:40" → "09:30" / "21:40"; anything else → null. */
    fun clock(value: String?): String? {
        val m = CLOCK.matchEntire(value?.trim() ?: return null) ?: return null
        return "%02d:%s".format(m.groupValues[1].toInt(), m.groupValues[2])
    }

    private fun parseDate(value: String): LocalDate? =
        try { LocalDate.parse(value.take(10)) } catch (_: Exception) { null }
}
