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
        val due = Meetings.due(listOf(ev(1, 4.9), ev(2, 5.0), ev(3, 5.5), ev(4, -1.0), ev(5, 0.5), ev(7, -6.0)), now, emptySet())
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
        assertNull(MailAlerts.parse("com.google.android.gm", false, "3 new messages", "x")) // no lines to read
        assertNull(MailAlerts.parse("com.google.android.gm", false, null, "x"))
    }

    @Test fun acceptsSingleEmailPostedAsSummaryAndFallsBackToBigText() {
        assertEquals(MailAlert("Maria", "Hi"), MailAlerts.parse("com.google.android.gm", true, "Maria", "Hi"))
        assertEquals(MailAlert("Nikos", "Invoice"), MailAlerts.parse("com.google.android.gm", false, "Nikos", null, "\nInvoice\nbody"))
        assertEquals("|Maria|Hi", MailAlert("Maria", "Hi").dedupKey)
    }

    @Test fun readsNewestLineOfABundleFromASecondAccount() {
        val a = MailAlerts.parse("com.google.android.gm", true, "2 new messages", "Nikos, Maria",
            account = "work@company.com", firstLine = MailLine("Nikos", "Contract v2"), lineCount = 2)
        assertEquals(MailAlert("Nikos", "Contract v2", "work@company.com", 2), a)
        val b = MailAlerts.parse("com.google.android.gm", true, "work@company.com", null,
            account = "work@company.com", firstLine = MailLine("Nikos", "Hi"), lineCount = 3)
        assertEquals(3, b?.count)
        assertEquals(MailLine("Nikos Pap", "Contract v2"), MailAlerts.splitLine("Nikos Pap   Contract v2"))
        assertEquals(MailLine(null, "just text"), MailAlerts.splitLine("just text"))
    }

    @Test fun pkceMatchesRfc7636Vector() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        val v = Pkce.newVerifier()
        assertEquals(64, v.length)
        assertTrue(v.all { it.isLetterOrDigit() || it == '-' || it == '_' })
    }
}
