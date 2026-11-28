package com.yoda.pet

import android.content.Context
import com.yoda.pet.logic.ConcertFeed
import com.yoda.pet.logic.FeedConcert
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Reads the public Listening Mirror "Deciding" deck from GitHub Pages and
 * reports concerts that weren't there last time. Uses ETag, so an
 * unchanged deck costs a few hundred bytes.
 */
class ConcertWatcher(context: Context) {
    private val ctx = context.applicationContext
    private val prefs = Prefs(ctx)
    private val io = Executors.newSingleThreadExecutor()

    fun check(onNew: (List<FeedConcert>) -> Unit) {
        if (!prefs.concertAlerts) return
        io.execute {
            val result = runCatching { fetch() }
            result.exceptionOrNull()?.let { YodaLog.add(ctx, "🎸 Couldn't check Listening Mirror: ${it.message}") }
            val current = result.getOrNull() ?: return@execute // null = unchanged (304)
            val seen = prefs.seenConcertIds
            val first = !prefs.concertFeedReady
            val fresh = ConcertFeed.newOnes(current, seen, first)
            // Remember what's in the deck now (plus recent history, so a concert
            // that drops out and comes back isn't announced twice).
            prefs.seenConcertIds = (seen.toList().takeLast(400) + current.map { it.id }).toSet()
            prefs.concertFeedReady = true
            if (first) YodaLog.add(ctx, "🎸 Listening Mirror connected — ${current.size} concerts in the deck")
            if (fresh.isNotEmpty()) {
                YodaLog.add(ctx, "🎸 New concert: ${fresh.joinToString { it.artist }}")
                onNew(fresh)
            }
        }
    }

    private fun fetch(): List<FeedConcert>? {
        val conn = URL(ConcertFeed.FEED_URL).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            prefs.concertEtag?.let { conn.setRequestProperty("If-None-Match", it) }
            val code = conn.responseCode
            if (code == 304) return null
            if (code !in 200..299) throw Exception("HTTP $code")
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            conn.getHeaderField("ETag")?.let { prefs.concertEtag = it }
            val arr = JSONObject(text).optJSONArray("concerts") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val id = o.optString("id").ifEmpty { return@mapNotNull null }
                FeedConcert(
                    id = id,
                    artist = o.optString("artist").ifEmpty { "A concert" },
                    venue = o.optString("venue").takeIf { it.isNotEmpty() && it != "null" },
                    city = o.optString("city").takeIf { it.isNotEmpty() && it != "null" },
                    date = o.optString("date").takeIf { it.isNotEmpty() && it != "null" },
                    festival = o.optBoolean("isFestival"),
                )
            }
        } finally {
            conn.disconnect()
        }
    }
}
