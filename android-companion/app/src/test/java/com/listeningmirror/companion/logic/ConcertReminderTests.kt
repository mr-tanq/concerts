package com.listeningmirror.companion.logic

import java.time.LocalDate
import java.time.LocalTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ConcertReminderTests {

    private val terror = ReminderConcert(
        id = "planned-terror",
        title = "Terror",
        date = "2026-12-02",
        endDate = null,
        venue = "Patronaat",
        city = "Haarlem",
        ticketBought = true,
        doors = "18:30",
        main = ReminderAct("Terror", "21:40"),
        support = listOf(
            ReminderAct("Bane", "20:40"),
            ReminderAct("Peace of Mind", "19:00"),
            ReminderAct("Magnitude", "19:50"),
        ),
    )
    private val day = LocalDate.parse("2026-12-02")

    @Test
    fun remindsOnTheDayFromNineWithDoorsHeadlinerAndRoom() {
        val due = ConcertReminder.due(listOf(terror), day, LocalTime.of(9, 5), emptySet())
        assertEquals(1, due.size)
        assertEquals("Terror tonight", due[0].title)
        assertEquals("Doors 18:30 · Terror 21:40 · Patronaat, Haarlem", due[0].text)
        assertEquals(
            "18:30  Doors\n19:00  Peace of Mind\n19:50  Magnitude\n20:40  Bane\n21:40  Terror\nPatronaat, Haarlem",
            due[0].details,
        )
    }

    @Test
    fun nothingBeforeNineNothingTwiceNothingOnOtherDays() {
        assertTrue(ConcertReminder.due(listOf(terror), day, LocalTime.of(8, 59), emptySet()).isEmpty())
        val first = ConcertReminder.due(listOf(terror), day, LocalTime.of(10, 0), emptySet())
        assertTrue(ConcertReminder.due(listOf(terror), day, LocalTime.of(11, 0), setOf(first[0].key)).isEmpty())
        assertTrue(ConcertReminder.due(listOf(terror), day.minusDays(1), LocalTime.NOON, emptySet()).isEmpty())
    }

    @Test
    fun onlyConcertsWithATicket() {
        val maybe = terror.copy(ticketBought = false)
        assertTrue(ConcertReminder.due(listOf(maybe), day, LocalTime.NOON, emptySet()).isEmpty())
    }

    @Test
    fun festivalsRemindOnEveryDayWithADayTimeTitle() {
        val fest = terror.copy(
            id = "planned-fest", title = "Jera On Air", date = "2027-06-24", endDate = "2027-06-26",
            venue = "Jera On Air", city = "Ysselsteyn", doors = null, main = ReminderAct("Jera On Air", "12:00"),
            support = emptyList(),
        )
        assertFalse(ConcertReminder.isOn(fest, LocalDate.parse("2027-06-23")))
        assertTrue(ConcertReminder.isOn(fest, LocalDate.parse("2027-06-25")))
        val keys = listOf("2027-06-24", "2027-06-25").map {
            ConcertReminder.due(listOf(fest), LocalDate.parse(it), LocalTime.NOON, emptySet()).single().key
        }
        assertEquals(2, keys.toSet().size)
        assertEquals("Jera On Air today",
            ConcertReminder.due(listOf(fest), LocalDate.parse("2027-06-24"), LocalTime.NOON, emptySet()).single().title)
    }

    @Test
    fun missingTimesAndNoSupportPlaceholders() {
        val bare = terror.copy(doors = null, main = ReminderAct("Terror", null), support = listOf(ReminderAct("Geen", "20:30")))
        val r = ConcertReminder.build(bare, day)
        assertEquals("Terror tonight", r.title)
        assertEquals("Patronaat, Haarlem", r.text)
        assertEquals("TBA    Terror\nPatronaat, Haarlem", r.details)
        assertEquals("09:30", ConcertReminder.clock("9.30"))
    }
}
