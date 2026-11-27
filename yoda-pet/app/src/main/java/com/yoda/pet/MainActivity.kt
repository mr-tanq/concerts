package com.yoda.pet

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import kotlin.math.roundToInt

/** Setup screen: permissions, Spotify, and the big Start/Hide button. */
class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var spotify: SpotifyClient
    private lateinit var list: LinearLayout

    private val ink = Color.parseColor("#3B2416")
    private val muted = Color.parseColor("#7A5A48")
    private val brown = Color.parseColor("#6B3A23")
    private val cream = Color.parseColor("#FFF4E6")
    private val green = Color.parseColor("#2E7D32")

    private fun dp(v: Int) = (v * resources.displayMetrics.density).roundToInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        spotify = SpotifyClient(this)
        window.statusBarColor = cream
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(40))
        }
        setContentView(ScrollView(this).apply {
            setBackgroundColor(cream)
            fitsSystemWindows = true
            addView(list)
        })
    }

    override fun onResume() {
        super.onResume()
        if (hasGmailAccess && !GmailListener.connected) GmailListener.rebind(this)
        render()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
    }

    // ---------------------------------------------------------------- state

    private val canOverlay get() = Settings.canDrawOverlays(this)
    private val hasCalendar get() = checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
    private val hasNotifications get() = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    private val hasGmailAccess: Boolean
        get() {
            val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
            val me = ComponentName(this, GmailListener::class.java)
            return flat.split(':').mapNotNull { ComponentName.unflattenFromString(it) }.any { it == me }
        }
    private val unrestrictedBattery get() = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    // ---------------------------------------------------------------- UI

    private fun render() {
        list.removeAllViews()

        list.addView(ImageView(this).apply {
            setImageResource(R.drawable.yoda_sit)
            adjustViewBounds = true
        }, LinearLayout.LayoutParams(dp(110), dp(190)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        list.addView(text("Yoda", 30f, ink, bold = true, center = true))
        list.addView(text("Your little French bulldog who lives at the bottom of your screen.", 15f, muted, center = true).apply {
            setPadding(0, dp(4), 0, dp(20))
        })

        val running = YodaService.isRunning
        list.addView(bigButton(if (running) "Hide Yoda" else "Show Yoda 🐾", enabled = canOverlay || running) {
            if (running) YodaService.stop(this) else {
                if (!hasNotifications && Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
                YodaService.start(this)
            }
            list.postDelayed({ render() }, 400)
        })
        if (!canOverlay) list.addView(text("First allow “Display over other apps” below.", 13f, muted, center = true).apply { setPadding(0, dp(6), 0, 0) })

        section("Permissions")
        step("Display over other apps", "So Yoda can walk on top of your other apps.", canOverlay) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        step("Calendar", "Meeting reminders 5 minutes before, from Google Calendar on this phone.", hasCalendar) {
            requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), 1)
        }
        step("Gmail alerts (notification access)",
            "Lets Yoda see Gmail's new-mail notifications to tell you who wrote. " +
                "If Android says “Restricted setting”: open App info for Yoda → ⋮ → Allow restricted settings, then try again.",
            hasGmailAccess) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        if (Build.VERSION.SDK_INT >= 33) {
            step("Notifications", "Needed for the small “Yoda is on your screen” notification.", hasNotifications) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
            }
        }
        step("Run in background", "Stops the battery saver from sending Yoda home.", unrestrictedBattery) {
            @Suppress("BatteryLife")
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }

        section("Spotify")
        if (spotify.isConnected) {
            list.addView(text("✓ Connected${prefs.spotifyUser?.let { " as $it" } ?: ""}. Tap Yoda to hear a random song from your Liked Songs.", 14f, green))
            list.addView(smallButton("Disconnect Spotify") { spotify.disconnect(); render() })
        } else {
            list.addView(text("Tap Yoda and he plays a random song from your Liked Songs.", 14f, ink))
            list.addView(text("One-time setup: in your app on developer.spotify.com, add this Redirect URI and save:\n${SpotifyClient.REDIRECT_URI}", 13f, muted).apply {
                setTextIsSelectable(true)
                setPadding(0, dp(6), 0, 0)
            })
            list.addView(smallButton("Connect Spotify") {
                startActivity(Intent(Intent.ACTION_VIEW, spotify.authorizeUri()))
            })
        }

        section("Alerts")
        toggle("Email alerts", "Tell me who new Gmail is from.", prefs.emailAlerts) { prefs.emailAlerts = it }
        list.addView(text(emailStatus(), 13f, muted).apply { setPadding(dp(4), 0, dp(4), dp(4)) })
        list.addView(smallButton("Test email bubble") {
            if (!YodaService.isRunning) {
                Toast.makeText(this, "Show Yoda first.", Toast.LENGTH_SHORT).show()
            } else {
                PetBus.post { it.announceEmail("Yoda (test)", "This is how a new email will look", null, force = true) }
                Toast.makeText(this, "Look at Yoda 🐾", Toast.LENGTH_SHORT).show()
            }
        })
        toggle("Meeting reminders", "Speech bubble 5 minutes before a meeting.", prefs.meetingAlerts) { prefs.meetingAlerts = it }
        list.addView(text(calendarStatus(), 13f, muted).apply { setPadding(dp(4), 0, dp(4), dp(4)) })
        list.addView(smallButton("Test meeting bubble") { testMeeting() })

        section("Size")
        val sizes = listOf("Small" to 72, "Medium" to 96, "Large" to 128)
        list.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            sizes.forEach { (label, size) ->
                val selected = prefs.petSizeDp == size
                addView(pill(label, selected) {
                    prefs.petSizeDp = size
                    if (YodaService.isRunning) { YodaService.stop(this@MainActivity); YodaService.start(this@MainActivity) }
                    render()
                }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(8) })
            }
        })

        section("How to use")
        list.addView(text(
            "• Tap Yoda: he jumps and plays one of your favourite songs.\n" +
                "• Hold Yoda: Encourage me, Say something funny, Check in on me, and email alerts on/off.\n" +
                "• 5 minutes before a meeting he tells you what it is.\n" +
                "• When new Gmail arrives he tells you who it's from, with an Open it button.\n" +
                "• To hide him: the “Hide Yoda” button above or in his notification.",
            14f, ink))
    }

    private fun calendarStatus(): String = when {
        !hasCalendar -> "✗ Calendar permission is off (see Permissions above)"
        !YodaService.isRunning -> "Yoda checks your calendar while he's on screen."
        else -> prefs.calendarStatus ?: "Checking…"
    }

    /** Shows the next meeting today as a reminder bubble, right now. */
    private fun testMeeting() {
        if (!YodaService.isRunning) { Toast.makeText(this, "Show Yoda first.", Toast.LENGTH_SHORT).show(); return }
        if (!hasCalendar) { Toast.makeText(this, "Allow Calendar first.", Toast.LENGTH_SHORT).show(); return }
        val now = System.currentTimeMillis()
        val next = try {
            CalendarReader.read(this, now, now + 24 * 3600_000L).firstOrNull { !it.allDay && !it.canceled && !it.declined && it.begin > now }
        } catch (e: Exception) {
            Toast.makeText(this, "Couldn't read the calendar: ${e.message}", Toast.LENGTH_LONG).show(); return
        }
        val clock = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(next?.begin ?: now))
        PetBus.post { pet ->
            if (next == null) {
                pet.announceMeeting("No meetings in the next 24 hours", "(this is a test)", null) {}
            } else {
                pet.announceMeeting(com.yoda.pet.logic.Meetings.displayTitle(next.title),
                    com.yoda.pet.logic.Meetings.whenText(next.begin, now, clock) + " (test)", next.location) {
                    val i = Intent(Intent.ACTION_VIEW, android.content.ContentUris.withAppendedId(android.provider.CalendarContract.Events.CONTENT_URI, next.eventId))
                        .putExtra(android.provider.CalendarContract.EXTRA_EVENT_BEGIN_TIME, next.begin)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { startActivity(i) }
                }
            }
        }
        Toast.makeText(this, "Look at Yoda 🐾", Toast.LENGTH_SHORT).show()
    }

    private fun emailStatus(): String {
        val fmt = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
        val listener = when {
            !hasGmailAccess -> "✗ Notification access is off (see Permissions above)"
            GmailListener.connected -> "✓ Listening for Gmail"
            else -> "… Access is on but Android hasn't connected Yoda yet. Turn the access off and on again, or restart the phone."
        }
        val last = prefs.lastMailSeen?.let { "Last Gmail notification: $it (${fmt.format(java.util.Date(prefs.lastMailSeenAt))})" }
            ?: "No Gmail notification seen yet. Check that Gmail notifications are on (Gmail → Settings → your account → Notifications: All)."
        return "$listener\n$last"
    }

    private fun section(title: String) {
        list.addView(text(title.uppercase(), 12f, muted, bold = true).apply {
            letterSpacing = 0.08f
            setPadding(0, dp(28), 0, dp(8))
        })
    }

    private fun step(title: String, detail: String, done: Boolean, action: () -> Unit) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = card()
        }
        val texts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text((if (done) "✓ " else "") + title, 15f, if (done) green else ink, bold = true))
            addView(text(detail, 13f, muted))
        }
        row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (!done) row.addView(pill("Allow", true, action), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(10) })
        list.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) })
    }

    private fun toggle(title: String, detail: String, on: Boolean, onChange: (Boolean) -> Unit) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(10), dp(8), dp(10))
            background = card()
        }
        row.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text(title, 15f, ink, bold = true))
            addView(text(detail, 13f, muted))
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(Switch(this).apply {
            isChecked = on
            setOnCheckedChangeListener { _, v -> onChange(v) }
        })
        list.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) })
    }

    private fun card() = GradientDrawable().apply {
        setColor(Color.WHITE)
        cornerRadius = dp(14).toFloat()
        setStroke(dp(1), Color.parseColor("#EAD9C6"))
    }

    private fun text(s: String, sp: Float, color: Int, bold: Boolean = false, center: Boolean = false) = TextView(this).apply {
        text = s
        setTextColor(color)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        if (center) gravity = Gravity.CENTER_HORIZONTAL
    }

    private fun bigButton(label: String, enabled: Boolean, onClick: () -> Unit) = TextView(this).apply {
        text = label
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
        typeface = Typeface.DEFAULT_BOLD
        setPadding(dp(16), dp(16), dp(16), dp(16))
        background = GradientDrawable().apply { setColor(brown); cornerRadius = dp(28).toFloat() }
        alpha = if (enabled) 1f else 0.4f
        setOnClickListener {
            if (enabled) onClick()
            else Toast.makeText(this@MainActivity, "Allow “Display over other apps” first.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun smallButton(label: String, onClick: () -> Unit) = pill(label, true, onClick).apply {
        (layoutParams as? LinearLayout.LayoutParams)?.topMargin = dp(10)
    }.let { v ->
        LinearLayout(this).apply {
            setPadding(0, dp(10), 0, 0)
            addView(v)
        }
    }

    private fun pill(label: String, filled: Boolean, onClick: () -> Unit) = TextView(this).apply {
        text = label
        gravity = Gravity.CENTER
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        typeface = Typeface.DEFAULT_BOLD
        setPadding(dp(16), dp(10), dp(16), dp(10))
        setTextColor(if (filled) Color.WHITE else brown)
        background = GradientDrawable().apply {
            setColor(if (filled) brown else Color.WHITE)
            cornerRadius = dp(20).toFloat()
            setStroke(dp(1), brown)
        }
        setOnClickListener { onClick() }
    }
}
