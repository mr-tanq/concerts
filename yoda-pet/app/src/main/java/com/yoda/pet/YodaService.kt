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
        main.post(meetingLoop)
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
        if (checkSelfPermission(Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED) return
        val now = System.currentTimeMillis()
        val events = runCatching { readEvents(now - 60_000, now + Meetings.LEAD_MS + 60_000) }.getOrDefault(emptyList())
        val announced = prefs.announcedMeetings
        val due = Meetings.due(events, now, announced)
        if (due.isEmpty()) return
        // Remember them all; keep the list short (only keys for recent meetings matter).
        prefs.announcedMeetings = (announced.toList().takeLast(50) + due.map { it.key }).toSet()
        val e = due.first()
        val mins = Meetings.minutesUntil(e.begin, now)
        val at = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(e.begin))
        val whenText = if (mins <= 1) "Starting in about a minute ($at)" else "Starts in $mins min, at $at"
        pet.announceMeeting(Meetings.displayTitle(e.title), whenText, e.location) { openEvent(e) }
    }

    private fun readEvents(from: Long, to: Long): List<CalendarEvent> {
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, from)
            ContentUris.appendId(it, to)
        }.build()
        val projection = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.STATUS,
            CalendarContract.Instances.SELF_ATTENDEE_STATUS,
            CalendarContract.Instances.VISIBLE,
        )
        val out = ArrayList<CalendarEvent>()
        contentResolver.query(uri, projection, null, null, CalendarContract.Instances.BEGIN + " ASC")?.use { c ->
            while (c.moveToNext()) {
                if (c.getInt(7) == 0) continue // calendar hidden in the Calendar app
                out += CalendarEvent(
                    eventId = c.getLong(0),
                    begin = c.getLong(1),
                    title = c.getString(2),
                    location = c.getString(3),
                    allDay = c.getInt(4) == 1,
                    canceled = !c.isNull(5) && c.getInt(5) == CalendarContract.Events.STATUS_CANCELED,
                    declined = !c.isNull(6) && c.getInt(6) == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED,
                )
            }
        }
        return out
    }

    private fun openEvent(e: CalendarEvent) {
        val intent = Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, e.eventId))
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, e.begin)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { startActivity(intent) }
    }
}
