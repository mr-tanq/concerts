package com.listeningmirror.companion.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.listeningmirror.companion.logic.ConcertReminder
import com.listeningmirror.companion.logic.Reminder
import com.listeningmirror.companion.logic.ReminderAct
import com.listeningmirror.companion.logic.ReminderConcert
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Concert-day reminders, posted by the Companion because it is the one part
 * of Listening Mirror that is always running on the phone.
 *
 * Every 30 minutes (while the playback foreground service is up) it reads
 * the public Going list the web app publishes on GitHub Pages and, from
 * 09:00 Amsterdam time on the day, posts one notification per concert with
 * a ticket: "Terror tonight · Doors 18:30 · Terror 21:40 · Patronaat,
 * Haarlem", with the running order when expanded. Each reminder is posted
 * once per concert per day. The read uses ETag revalidation, so an
 * unchanged list costs a few hundred bytes.
 *
 * The decisions (which concert, what text) live in logic/ConcertReminder.kt
 * and are unit-tested; this file only fetches, parses and posts.
 */
object ConcertReminders {

    const val FEED_URL = "https://mr-tanq.github.io/concerts/data/planned.json"
    const val APP_URL = "https://mr-tanq.github.io/concerts/"

    private const val CHANNEL_ID = "lm_concert_day"
    private const val PREFS = "lm_concert_reminders"
    private const val KEY_SENT = "sent"
    private const val CHECK_EVERY_MINUTES = 30L
    private const val NOTIFICATION_BASE = 5200
    private val ZONE: ZoneId = ZoneId.of("Europe/Amsterdam")

    @Volatile private var executor: ScheduledExecutorService? = null
    @Volatile private var etag: String? = null
    @Volatile private var cached: List<ReminderConcert>? = null

    /** Start the periodic check. Idempotent. */
    @Synchronized
    fun start(context: Context) {
        if (executor != null) return
        val app = context.applicationContext
        executor = Executors.newSingleThreadScheduledExecutor().also {
            it.scheduleWithFixedDelay(
                { try { check(app) } catch (_: Throwable) { /* never take the service down */ } },
                1, CHECK_EVERY_MINUTES, TimeUnit.MINUTES,
            )
        }
    }

    @Synchronized
    fun stop() {
        executor?.shutdownNow()
        executor = null
    }

    /** One check: post whatever is due today and hasn't been posted yet. */
    fun check(context: Context) {
        val now = ZonedDateTime.now(ZONE)
        if (now.toLocalTime().isBefore(ConcertReminder.SEND_FROM)) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val sent = prefs.getStringSet(KEY_SENT, null)?.toSet() ?: emptySet()
        val concerts = fetch() ?: return
        val today = now.toLocalDate()
        val due = ConcertReminder.due(concerts, today, now.toLocalTime(), sent)
        if (due.isEmpty()) return
        due.forEach { post(context, it, test = false) }
        // Remember what was posted; forget anything older than a week.
        val keep = (sent + due.map { it.key }).filter { key ->
            val day = runCatching { LocalDate.parse(key.substringAfterLast('@')) }.getOrNull()
            day != null && !day.isBefore(today.minusDays(7))
        }.toSet()
        prefs.edit().putStringSet(KEY_SENT, keep).apply()
    }

    /**
     * For the Companion screen's "Send a test reminder": posts what the
     * reminder for your next concert with a ticket will look like. Returns a
     * short status line. Call off the main thread.
     */
    fun postTest(context: Context): String {
        val concerts = fetch() ?: return "Couldn't read your concerts. Check the connection and try again."
        val today = ZonedDateTime.now(ZONE).toLocalDate()
        val next = concerts
            .filter { it.ticketBought }
            .filter { c -> runCatching { !LocalDate.parse(c.endDate ?: c.date).isBefore(today) }.getOrDefault(false) }
            .minByOrNull { it.date }
            ?: return "No upcoming concert with a ticket. Mark one with “I have a ticket” in the app."
        val reminder = ConcertReminder.build(next, LocalDate.parse(next.date))
        return if (post(context, reminder, test = true)) {
            "Test sent: ${reminder.title} (on ${next.date} at 09:00 it comes by itself)."
        } else {
            "Notifications are off for the Companion. Allow them in Android settings."
        }
    }

    // ---------- fetch + parse ----------

    private fun fetch(): List<ReminderConcert>? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(FEED_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 15_000
                useCaches = false
                setRequestProperty("Accept", "application/json")
                etag?.let { setRequestProperty("If-None-Match", it) }
            }
            when (conn.responseCode) {
                HttpURLConnection.HTTP_NOT_MODIFIED -> cached
                in 200..299 -> {
                    val text = conn.inputStream.bufferedReader().use { it.readText() }
                    parse(text).also {
                        cached = it
                        etag = conn.getHeaderField("ETag")
                    }
                }
                else -> cached
            }
        } catch (_: Exception) {
            cached
        } finally {
            conn?.disconnect()
        }
    }

    /** planned.json → the fields a reminder needs. Unknown shapes are skipped. */
    fun parse(text: String): List<ReminderConcert> {
        val list = JSONObject(text).optJSONArray("concerts") ?: return emptyList()
        val out = ArrayList<ReminderConcert>(list.length())
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            val id = str(o, "id") ?: continue
            val date = str(o, "date") ?: continue
            val title = str(o, "festivalName") ?: str(o, "artist") ?: continue
            // Only a schedule checked for this date counts.
            val s = o.optJSONObject("schedule")?.takeIf { str(it, "date") == date }
            val noSupport = s != null && !s.isNull("noSupport") && s.has("noSupport")
            val support = if (s == null || noSupport) emptyList() else {
                val arr = s.optJSONArray("support")
                (0 until (arr?.length() ?: 0)).mapNotNull { j -> act(arr?.optJSONObject(j), null) }
            }
            out += ReminderConcert(
                id = id,
                title = title,
                date = date,
                endDate = str(o, "endDate"),
                venue = str(o, "venue"),
                city = str(o, "city"),
                ticketBought = o.optJSONObject("practical")?.optBoolean("ticketBought", false) == true,
                doors = s?.optJSONObject("doors")?.let { str(it, "time") },
                main = act(s?.optJSONObject("main"), title) ?: ReminderAct(title, null),
                support = support,
            )
        }
        return out
    }

    private fun act(o: JSONObject?, fallbackName: String?): ReminderAct? {
        if (o == null) return null
        val name = str(o, "name") ?: fallbackName ?: return null
        return ReminderAct(name, str(o, "time"))
    }

    /** JSON string or null — never the text "null" org.json returns for nulls. */
    private fun str(o: JSONObject, key: String): String? =
        if (!o.has(key) || o.isNull(key)) null else o.optString(key).trim().ifEmpty { null }

    // ---------- notification ----------

    private fun ensureChannel(context: Context): NotificationManager? {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return null
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Concert day", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "A reminder on the day of a concert you have a ticket for."
                }
            )
        }
        return manager
    }

    /** Returns false when notifications are blocked for the app. */
    private fun post(context: Context, r: Reminder, test: Boolean): Boolean {
        val manager = ensureChannel(context) ?: return false
        if (!manager.areNotificationsEnabled()) return false
        val open = PendingIntent.getActivity(
            context,
            r.concertId.hashCode(),
            Intent(Intent.ACTION_VIEW, Uri.parse(APP_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setContentTitle(if (test) "Test · ${r.title}" else r.title)
            .setContentText(r.text)
            .setStyle(Notification.BigTextStyle().bigText(r.details))
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_EVENT)
            .build()
        return try {
            manager.notify(NOTIFICATION_BASE + (r.key.hashCode() and 0xFFF), notification)
            true
        } catch (_: SecurityException) {
            false
        }
    }
}
