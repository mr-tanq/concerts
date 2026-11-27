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

    /** Throws if the calendar can't be read, so callers can show why. */
    fun read(ctx: Context, from: Long, to: Long): List<CalendarEvent> {
        val uri = Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, from)
            ContentUris.appendId(it, to)
        }.build()
        // Minimal, always-available columns. Some phones' calendar providers
        // reject extra columns, which used to make the whole query fail.
        val projection = arrayOf(
            Instances.EVENT_ID, Instances.BEGIN, Instances.TITLE, Instances.EVENT_LOCATION,
            Instances.ALL_DAY, Instances.STATUS, Instances.SELF_ATTENDEE_STATUS,
        )
        val cursor = ctx.contentResolver.query(uri, projection, null, null, Instances.BEGIN + " ASC")
            ?: throw IllegalStateException("calendar provider returned nothing")
        val out = ArrayList<CalendarEvent>()
        cursor.use { c ->
            while (c.moveToNext()) {
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
