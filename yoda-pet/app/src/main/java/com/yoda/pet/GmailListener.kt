package com.yoda.pet

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.yoda.pet.logic.MailAlerts

/**
 * Watches for Gmail's "new email" notifications. Only Gmail's are looked
 * at; everything else is ignored. Nothing is stored or sent anywhere.
 */
class GmailListener : NotificationListenerService() {

    private val seen = LinkedHashSet<String>()
    private var connectedAt = 0L

    override fun onListenerConnected() {
        connectedAt = System.currentTimeMillis()
        // Don't re-announce mail that was already sitting in the shade.
        runCatching { activeNotifications }.getOrNull()?.forEach { remember(signature(it)) }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != MailAlerts.GMAIL_PACKAGE) return
        if (!Prefs(this).emailAlerts) return
        val n = sbn.notification
        val extras = n.extras
        val alert = MailAlerts.parse(
            sbn.packageName,
            n.flags and Notification.FLAG_GROUP_SUMMARY != 0,
            extras.getCharSequence(Notification.EXTRA_TITLE),
            extras.getCharSequence(Notification.EXTRA_TEXT),
        ) ?: return
        // Gmail re-posts the same notification on sync; only announce new ones.
        if (!remember(signature(sbn))) return
        PetBus.post { it.announceEmail(alert.sender, alert.subject, n.contentIntent) }
    }

    private fun signature(sbn: StatusBarNotification): String {
        val e = sbn.notification.extras
        return "${sbn.key}|${e.getCharSequence(Notification.EXTRA_TITLE)}|${e.getCharSequence(Notification.EXTRA_TEXT)}"
    }

    /** Returns true if this signature is new. */
    private fun remember(sig: String): Boolean {
        if (!seen.add(sig)) return false
        while (seen.size > 200) seen.remove(seen.first())
        return true
    }
}
