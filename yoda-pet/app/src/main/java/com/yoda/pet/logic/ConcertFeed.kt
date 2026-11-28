package com.yoda.pet.logic

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One concert in the Listening Mirror "Deciding" deck (data/recommendations.json). */
data class FeedConcert(
    val id: String,
    val artist: String,
    val venue: String?,
    val city: String?,
    val date: String?,
    val festival: Boolean,
)

object ConcertFeed {
    const val FEED_URL = "https://mr-tanq.github.io/concerts/data/recommendations.json"
    const val APP_URL = "https://mr-tanq.github.io/concerts/"

    /**
     * Concerts that are new since last time. On the very first check
     * ([firstRun]) everything already in the deck is treated as known, so
     * Yoda doesn't announce a pile of old concerts at once.
     */
    fun newOnes(current: List<FeedConcert>, seen: Set<String>, firstRun: Boolean): List<FeedConcert> =
        if (firstRun) emptyList() else current.filter { it.id !in seen }.distinctBy { it.id }

    /** "013, Tilburg · Sun 29 Nov" */
    fun where(c: FeedConcert): String {
        val place = listOfNotNull(c.venue?.takeIf { it.isNotBlank() }, c.city?.takeIf { it.isNotBlank() && it != c.venue })
            .joinToString(", ")
        val day = c.date?.let { runCatching { LocalDate.parse(it).format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.ENGLISH)) }.getOrNull() }
        return listOfNotNull(place.takeIf { it.isNotEmpty() }, day, if (c.festival) "festival" else null).joinToString(" · ")
    }
}
