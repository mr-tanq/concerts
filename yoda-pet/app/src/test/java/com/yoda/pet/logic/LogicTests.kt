package com.yoda.pet.logic

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LogicTests {
    private val now = 1_000_000_000L
    private fun ev(id: Long, inMin: Double, allDay: Boolean = false, canceled: Boolean = false, declined: Boolean = false) =
        CalendarEvent(id, now + (inMin * 60_000).toLong(), "Meeting $id", null, allDay, canceled, declined)

    @Test fun announcesMeetingsStartingWithinFiveMinutes() {
        val due = Meetings.due(listOf(ev(1, 4.9), ev(2, 5.0), ev(3, 5.5), ev(4, -1.0), ev(5, 0.5), ev(7, -3.0)), now, emptySet())
        assertEquals(listOf(4L, 5L, 1L, 2L), due.map { it.eventId })
    }

    @Test fun skipsAllDayCancelledDeclinedAndAlreadyAnnounced() {
        val events = listOf(ev(1, 3.0, allDay = true), ev(2, 3.0, canceled = true), ev(3, 3.0, declined = true), ev(4, 3.0), ev(6, 2.0))
        val due = Meetings.due(events, now, setOf(events[3].key))
        assertEquals(listOf(6L), due.map { it.eventId })
    }

    @Test fun minutesRoundUp() {
        assertEquals(5, Meetings.minutesUntil(now + 4 * 60_000 + 1, now))
        assertEquals(1, Meetings.minutesUntil(now + 10_000, now))
        assertEquals("(no title)", Meetings.displayTitle("  "))
        assertEquals("Starts in 5 min, at 10:00", Meetings.whenText(now + 5 * 60_000, now, "10:00"))
        assertEquals("Started 1 min ago (10:00)", Meetings.whenText(now - 90_000, now, "10:00"))
    }

    @Test fun parsesGmailSenderAndSubject() {
        val a = MailAlerts.parse("com.google.android.gm", false, "Maria Papadopoulou", "Dinner on Friday?\nmore")
        assertEquals(MailAlert("Maria Papadopoulou", "Dinner on Friday?"), a)
    }

    @Test fun ignoresSummariesOtherAppsAndRollups() {
        assertNull(MailAlerts.parse("com.whatsapp", false, "Maria", "Hi"))
        assertNull(MailAlerts.parse("com.google.android.gm", false, "3 new messages", "x"))
        assertNull(MailAlerts.parse("com.google.android.gm", false, null, "x"))
    }

    @Test fun acceptsSingleEmailPostedAsSummaryAndFallsBackToBigText() {
        assertEquals(MailAlert("Maria", "Hi"), MailAlerts.parse("com.google.android.gm", true, "Maria", "Hi"))
        assertEquals(MailAlert("Nikos", "Invoice"), MailAlerts.parse("com.google.android.gm", false, "Nikos", null, "\nInvoice\nbody"))
        assertNull(MailAlerts.parse("com.google.android.gm", true, "me@gmail.com", "Maria: Hi", account = "me@gmail.com"))
        assertEquals("Maria|Hi", MailAlert("Maria", "Hi").dedupKey)
    }

    @Test fun pkceMatchesRfc7636Vector() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        val v = Pkce.newVerifier()
        assertEquals(64, v.length)
        assertTrue(v.all { it.isLetterOrDigit() || it == '-' || it == '_' })
    }
}
