package com.yoda.pet

import android.app.Notification
import android.content.Context
import android.service.notification.StatusBarNotification
import org.json.JSONObject

/**
 * Notifications from apps you picked in Yoda's settings (Listening Mirror
 * Companion, Paper World, GitHub, …) — Yoda reads them out in a bubble.
 *
 * Every app that posts a normal notification is remembered by name only
 * (on the phone, never sent anywhere), so it can be offered in the list.
 */
object OtherApps {
    private val browsers = setOf(
        "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.brave.browser",
        "com.microsoft.emmx", "org.mozilla.firefox", "com.sec.android.app.sbrowser", "com.opera.browser",
    )
    private val ignored = setOf("android", "com.android.systemui", "com.yoda.pet", "com.google.android.gms")

    data class SeenApp(val key: String, val label: String, val lastTitle: String?, val at: Long)

    private val seenSignatures = LinkedHashSet<String>()

    fun onPosted(ctx: Context, sbn: StatusBarNotification) {
        val pkg = sbn.packageName
        if (pkg in ignored) return
        val n = sbn.notification
        val e = n.extras
        if (n.flags and (Notification.FLAG_ONGOING_EVENT or Notification.FLAG_FOREGROUND_SERVICE or Notification.FLAG_GROUP_SUMMARY) != 0) return
        if (n.category == Notification.CATEGORY_TRANSPORT || n.category == Notification.CATEGORY_PROGRESS ||
            n.category == Notification.CATEGORY_CALL || e.containsKey(Notification.EXTRA_MEDIA_SESSION)) return
        val title = e.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val text = (e.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: e.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.trim().orEmpty()
        if (title.isEmpty() && text.isEmpty()) return

        // Websites (e.g. a web app in Chrome) are told apart by their address.
        val site = if (pkg in browsers) e.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.trim()?.takeIf { it.isNotEmpty() } else null
        val key = if (site != null) "$pkg|$site" else pkg
        val label = if (site != null) site else appLabel(ctx, pkg)
        val prefs = Prefs(ctx)
        remember(prefs, key, label, title)

        if (key !in prefs.forwardApps) return
        val sig = "${sbn.key}|$title|$text"
        synchronized(seenSignatures) {
            if (!seenSignatures.add(sig)) return
            while (seenSignatures.size > 300) seenSignatures.remove(seenSignatures.first())
        }
        if (PetBus.overlay == null) { YodaLog.add(ctx, "🔔 $label: $title → Yoda wasn't on screen"); return }
        YodaLog.add(ctx, "🔔 $label: $title → announced ✓")
        PetBus.post { it.announceApp(label, title, text, n.contentIntent, pkg) }
    }

    @Synchronized
    private fun remember(prefs: Prefs, key: String, label: String, title: String) {
        val json = runCatching { JSONObject(prefs.seenApps) }.getOrDefault(JSONObject())
        val now = System.currentTimeMillis()
        val old = json.optJSONObject(key)
        if (old != null && now - old.optLong("at") < 10 * 60_000 && old.optString("label") == label) return
        json.put(key, JSONObject().put("label", label).put("last", title.take(80)).put("at", now))
        // Keep the 60 most recent apps.
        if (json.length() > 60) {
            val oldest = json.keys().asSequence().minByOrNull { json.optJSONObject(it)?.optLong("at") ?: 0L }
            oldest?.let { json.remove(it) }
        }
        prefs.seenApps = json.toString()
    }

    fun seen(ctx: Context): List<SeenApp> {
        val json = runCatching { JSONObject(Prefs(ctx).seenApps) }.getOrDefault(JSONObject())
        return json.keys().asSequence().mapNotNull { k ->
            val o = json.optJSONObject(k) ?: return@mapNotNull null
            SeenApp(k, o.optString("label", k), o.optString("last").takeIf { it.isNotEmpty() }, o.optLong("at"))
        }.sortedByDescending { it.at }.toList()
    }

    private fun appLabel(ctx: Context, pkg: String): String = runCatching {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)
}
