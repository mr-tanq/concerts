package com.yoda.pet

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.database.ContentObserver
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.CalendarContract
import android.provider.Settings
import android.view.Display
import android.view.WindowManager
import com.yoda.pet.logic.CalendarEvent
import com.yoda.pet.logic.Meetings
import java.text.DateFormat
import java.util.Date

/** Keeps Yoda on screen while you use other apps, and watches the calendar. */
class YodaService : Service() {

    companion object {
        private const val CHANNEL = "yoda"
        private const val NOTIF_ID = 1
        private const val ACTION_STOP = "com.yoda.pet.STOP"

        fun start(ctx: Context) {
            Prefs(ctx).yodaEnabled = true
            ctx.startForegroundService(Intent(ctx, YodaService::class.java))
        }

        fun stop(ctx: Context) {
            Prefs(ctx).yodaEnabled = false
            ctx.stopService(Intent(ctx, YodaService::class.java))
        }

        @Volatile
        var isRunning = false
            private set
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: Prefs
    private var overlay: PetOverlay? = null

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                Intent.ACTION_SCREEN_OFF -> overlay?.pause()
                Intent.ACTION_USER_PRESENT, Intent.ACTION_SCREEN_ON -> { overlay?.resume(); checkMeetings() }
            }
        }
    }

    private val checkNow = Runnable { checkMeetings() }
    private var lastCalendarSummary: String? = null

    /** Re-check right away whenever any calendar changes (e.g. you just added an event). */
    private val calendarObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) {
            main.removeCallbacks(checkNow)
            main.postDelayed(checkNow, 1500)
        }
    }

    private var concertWatcher: ConcertWatcher? = null
    private val concertLoop = object : Runnable {
        override fun run() {
            checkConcerts()
            main.postDelayed(this, 15 * 60_000L)
        }
    }

    private fun checkConcerts() {
        concertWatcher?.check { fresh -> main.post { overlay?.announceConcerts(fresh) } }
    }

    private val meetingLoop = object : Runnable {
        override fun run() {
            checkMeetings()
            main.postDelayed(this, 30_000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        startInForeground()
        if (!Settings.canDrawOverlays(this)) {
            prefs.yodaEnabled = false
            stopSelf()
            return
        }
        isRunning = true
        overlay = PetOverlay(overlayContext()).also { it.show() }
        registerReceiver(screenReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        })
        runCatching { contentResolver.registerContentObserver(CalendarContract.CONTENT_URI, true, calendarObserver) }
        YodaLog.add(this, "🐾 Yoda started")
        main.post(meetingLoop)
        concertWatcher = ConcertWatcher(this)
        main.postDelayed(concertLoop, 20_000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stop(this)
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        overlay?.onScreenSizeChanged()
    }

    override fun onDestroy() {
        isRunning = false
        main.removeCallbacks(meetingLoop)
        main.removeCallbacks(concertLoop)
        main.removeCallbacks(checkNow)
        runCatching { contentResolver.unregisterContentObserver(calendarObserver) }
        YodaLog.add(this, "🐾 Yoda stopped")
        runCatching { unregisterReceiver(screenReceiver) }
        overlay?.hide()
        overlay = null
        super.onDestroy()
    }

    /** Android 11+ wants overlay windows created from a window context, not a bare service. */
    private fun overlayContext(): Context {
        if (Build.VERSION.SDK_INT < 30) return this
        val display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY) ?: return this
        return createDisplayContext(display).createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Yoda on screen", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Shown while Yoda is walking around your screen."
            setShowBadge(false)
        })
        val openApp = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stopIntent = PendingIntent.getService(this, 1, Intent(this, YodaService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_paw)
            .setContentTitle("Yoda is on your screen 🐾")
            .setContentText("Tap to open settings")
            .setContentIntent(openApp)
            .addAction(Notification.Action.Builder(null, "Hide Yoda", stopIntent).build())
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    // ---------------------------------------------------------------- calendar

    private fun checkMeetings() {
        val pet = overlay ?: return
        if (!prefs.meetingAlerts) return
        if (!CalendarReader.hasPermission(this)) {
            prefs.calendarStatus = "✗ No calendar permission"
            return
        }
        val now = System.currentTimeMillis()
        val events = try {
            CalendarReader.read(this, now - 10 * 60_000, now + 24 * 3600_000L)
        } catch (e: Exception) {
            prefs.calendarStatus = "✗ Couldn't read the calendar: ${e.message}"
            logCalendar("📅 Couldn't read the calendar: ${e.message}")
            return
        }
        val upcoming = events.filter { !it.allDay && !it.canceled && !it.declined && it.begin > now }
        val fmt = DateFormat.getTimeInstance(DateFormat.SHORT)
        prefs.calendarStatus = "✓ Checked at ${fmt.format(Date(now))}. " + (upcoming.firstOrNull()
            ?.let { "Next meeting: ${Meetings.displayTitle(it.title)} at ${fmt.format(Date(it.begin))}" }
            ?: "No meetings in the next 24 hours.")
        val next = upcoming.firstOrNull()
        logCalendar(next?.let {
            "📅 Next meeting: ${Meetings.displayTitle(it.title)} at ${fmt.format(Date(it.begin))} — I'll speak 5 min before"
        } ?: "📅 No meetings in the next 24 hours")
        // Wake up exactly at the 5-minute mark instead of waiting for the next 30 s tick.
        main.removeCallbacks(checkNow)
        if (next != null) {
            val wait = next.begin - Meetings.LEAD_MS - now + 1000
            if (wait in 1..(30 * 60_000L)) main.postDelayed(checkNow, wait)
        }
        val announced = prefs.announcedMeetings
        val due = Meetings.due(events, now, announced)
        if (due.isEmpty()) return
        prefs.announcedMeetings = (announced.toList().takeLast(50) + due.map { it.key }).toSet()
        val e = due.first()
        YodaLog.add(this, "📅 Announced: ${Meetings.displayTitle(e.title)}")
        pet.announceMeeting(Meetings.displayTitle(e.title), Meetings.whenText(e.begin, now, fmt.format(Date(e.begin))), e.location) { openEvent(e) }
    }

    private fun logCalendar(line: String) {
        if (line == lastCalendarSummary) return
        lastCalendarSummary = line
        YodaLog.add(this, line)
    }

    private fun openEvent(e: CalendarEvent) {
        val intent = Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, e.eventId))
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, e.begin)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { startActivity(intent) }
    }
}
