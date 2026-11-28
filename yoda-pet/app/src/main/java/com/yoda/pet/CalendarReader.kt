package com.yoda.pet

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.provider.CalendarContract.Instances
import com.yoda.pet.logic.CalendarEvent

/** Reads upcoming event occurrences from the calendars synced to the phone (Google Calendar included). */
object CalendarReader {

    fun hasPermission(ctx: Context) =
        ctx.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

    data class CalendarInfo(val id: Long, val name: String, val account: String, val visible: Boolean)

    /** Every calendar on the phone, grouped by account. */
    fun calendars(ctx: Context): List<CalendarInfo> {
        val proj = arrayOf(
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.VISIBLE,
        )
        val out = ArrayList<CalendarInfo>()
        ctx.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, proj, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                out += CalendarInfo(c.getLong(0), c.getString(1) ?: "(no name)", c.getString(2) ?: "", c.getInt(3) == 1)
            }
        }
        return out.sortedWith(compareBy({ it.account.lowercase() }, { it.name.lowercase() }))
    }

    /**
     * Calendars Yoda listens to: the ones picked in the app, or — until you
     * pick — the ones switched on (visible) in your calendar app.
     */
    fun selectedIds(ctx: Context): Set<Long> {
        Prefs(ctx).calendarIds?.let { ids -> return ids.mapNotNull { it.toLongOrNull() }.toSet() }
        return calendars(ctx).filter { it.visible }.map { it.id }.toSet()
    }

    /** Throws if the calendar can't be read, so callers can show why. */
    fun read(ctx: Context, from: Long, to: Long): List<CalendarEvent> {
        val allowed = selectedIds(ctx)
        val uri = Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, from)
            ContentUris.appendId(it, to)
        }.build()
        // Minimal, always-available columns. Some phones' calendar providers
        // reject extra columns, which used to make the whole query fail.
        val projection = arrayOf(
            Instances.EVENT_ID, Instances.BEGIN, Instances.TITLE, Instances.EVENT_LOCATION,
            Instances.ALL_DAY, Instances.STATUS, Instances.SELF_ATTENDEE_STATUS, Instances.CALENDAR_ID,
        )
        val cursor = ctx.contentResolver.query(uri, projection, null, null, Instances.BEGIN + " ASC")
            ?: throw IllegalStateException("calendar provider returned nothing")
        val out = ArrayList<CalendarEvent>()
        cursor.use { c ->
            while (c.moveToNext()) {
                if (c.getLong(7) !in allowed) continue
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
}
