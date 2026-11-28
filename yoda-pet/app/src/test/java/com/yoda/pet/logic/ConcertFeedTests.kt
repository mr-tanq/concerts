package com.yoda.pet.logic

import kotlin.test.Test
import kotlin.test.assertEquals

class ConcertFeedTests {
    private val a = FeedConcert("rec-1", "Sevendust", "013", "Tilburg", "2026-11-29", false)
    private val b = FeedConcert("rec-2", "Roadburn", "013", "Tilburg", "2027-04-16", true)

    @Test fun firstRunAnnouncesNothing() {
        assertEquals(emptyList(), ConcertFeed.newOnes(listOf(a, b), emptySet(), firstRun = true))
    }

    @Test fun announcesOnlyUnseen() {
        assertEquals(listOf(b), ConcertFeed.newOnes(listOf(a, b, b), setOf("rec-1"), firstRun = false))
    }

    @Test fun describesWhereAndWhen() {
        assertEquals("013, Tilburg · Sun 29 Nov", ConcertFeed.where(a))
        assertEquals("013, Tilburg · Fri 16 Apr · festival", ConcertFeed.where(b))
        assertEquals("Paradiso", ConcertFeed.where(FeedConcert("x", "X", "Paradiso", "Paradiso", "bad", false)))
    }
}
