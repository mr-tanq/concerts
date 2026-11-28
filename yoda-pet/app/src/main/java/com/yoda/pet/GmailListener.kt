package com.yoda.pet

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.graphics.Typeface
import android.text.Spanned
import android.text.style.StyleSpan
import com.yoda.pet.logic.MailAlerts
import com.yoda.pet.logic.MailLine

/**
 * Watches for Gmail's "new email" notifications. Only Gmail's are looked
 * at; everything else is ignored. Nothing is sent anywhere — the last one
 * seen is kept on the phone only so the app can show "last email seen".
 */
class GmailListener : NotificationListenerService() {

    companion object {
        @Volatile
        var connected = false
            private set

        /** Ask Android to reconnect the listener (it sometimes drops it after an update). */
        fun rebind(ctx: Context) {
            runCatching { requestRebind(ComponentName(ctx, GmailListener::class.java)) }
        }

        private val seenKeys = LinkedHashSet<String>()
        private val recentMail = LinkedHashMap<String, Long>()
    }

    override fun onListenerConnected() {
        connected = true
        Prefs(this).mailListenerConnectedAt = System.currentTimeMillis()
        YodaLog.add(this, "📧 Email listener connected")
        // Don't re-announce mail that was already sitting in the shade.
        runCatching { activeNotifications }.getOrNull()?.forEach { remember(signature(it)) }
    }

    override fun onListenerDisconnected() {
        connected = false
        YodaLog.add(this, "📧 Email listener disconnected by Android — reconnecting")
        rebind(this)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in MailAlerts.PACKAGES) return
        val prefs = Prefs(this)
        val n = sbn.notification
        val e = n.extras
        val title = e.getCharSequence(Notification.EXTRA_TITLE)
        val text = e.getCharSequence(Notification.EXTRA_TEXT)
        val summary = n.flags and Notification.FLAG_GROUP_SUMMARY != 0
        val account = e.getCharSequence(Notification.EXTRA_SUB_TEXT)

        fun log(outcome: String) {
            prefs.lastMailSeenAt = System.currentTimeMillis()
            prefs.lastMailSeen = "${title ?: "(no title)"} — $outcome"
            YodaLog.add(this, "📧 ${appName(sbn.packageName)}${account?.let { " ($it)" } ?: ""}: ${title ?: "(no title)"}${if (summary) " [summary]" else ""} → $outcome")
        }

        if (!remember(signature(sbn))) return // Gmail re-posting the same thing on sync
        val lines = e.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        val alert = MailAlerts.parse(
            sbn.packageName, summary, title, text,
            bigText = e.getCharSequence(Notification.EXTRA_BIG_TEXT),
            account = account,
            firstLine = lines?.firstOrNull()?.let(::splitLine),
            lineCount = lines?.size ?: 0,
        )
        when {
            alert == null -> log("skipped (couldn't tell who it's from)")
            !prefs.emailAlerts -> log("email alerts are off")
            PetBus.overlay == null -> log("Yoda wasn't on screen")
            isRecent(alert.dedupKey) -> log("already announced")
            else -> {
                log("announced ✓")
                PetBus.post { it.announceEmail(alert.sender, alert.subject, n.contentIntent, account = alert.account, count = alert.count, app = sbn.packageName) }
            }
        }
    }

    private fun appName(pkg: String): String = runCatching {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    /** "Sender  Subject": Gmail makes the sender bold, so use the first bold span when there is one. */
    private fun splitLine(line: CharSequence): MailLine {
        if (line is Spanned) {
            val bold = line.getSpans(0, line.length, StyleSpan::class.java)
                .filter { it.style and Typeface.BOLD != 0 }
                .minByOrNull { line.getSpanStart(it) }
            if (bold != null && line.getSpanStart(bold) == 0) {
                val end = line.getSpanEnd(bold)
                return MailLine(line.subSequence(0, end).toString().trim(), line.subSequence(end, line.length).toString().trim())
            }
        }
        return MailAlerts.splitLine(line.toString())
    }

    private fun signature(sbn: StatusBarNotification): String {
        val e = sbn.notification.extras
        return "${sbn.key}|${e.getCharSequence(Notification.EXTRA_TITLE)}|${e.getCharSequence(Notification.EXTRA_TEXT)}"
    }

    /** Returns true if this signature is new. */
    private fun remember(sig: String): Boolean = synchronized(seenKeys) {
        if (!seenKeys.add(sig)) return false
        while (seenKeys.size > 300) seenKeys.remove(seenKeys.first())
        true
    }

    /** Same sender+subject within 10 minutes counts as the same email. */
    private fun isRecent(key: String): Boolean = synchronized(recentMail) {
        val now = System.currentTimeMillis()
        recentMail.entries.removeAll { now - it.value > 10 * 60_000 }
        if (recentMail.containsKey(key)) return true
        recentMail[key] = now
        false
    }
}
