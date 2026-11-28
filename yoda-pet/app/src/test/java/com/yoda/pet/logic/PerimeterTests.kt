package com.yoda.pet.logic

import kotlin.test.Test
import kotlin.test.assertEquals

class PerimeterTests {
    // 1000 x 2000 area, Yoda 100 wide x 90 tall.
    private val p = Perimeter(1000, 2000, 100, 90, wholeScreen = true)

    @Test fun walksAllFourEdgesCounterClockwise() {
        assertEquals(Perimeter.Pose(0, 1910, 100, 90, 0, Perimeter.Edge.BOTTOM), p.pose(0f))
        assertEquals(Perimeter.Pose(910, 1900, 90, 100, -90, Perimeter.Edge.RIGHT), p.pose(900f))
        assertEquals(Perimeter.Pose(910, 0, 90, 100, -90, Perimeter.Edge.RIGHT), p.pose(900f + 1899.5f))
        assertEquals(Perimeter.Pose(900, 0, 100, 90, 180, Perimeter.Edge.TOP), p.pose(900f + 1900f))
        assertEquals(Perimeter.Pose(0, 0, 90, 100, 90, Perimeter.Edge.LEFT), p.pose(900f + 1900f + 900f))
        assertEquals(5600f, p.length)
        assertEquals(p.pose(10f), p.pose(5610f)) // wraps around
        assertEquals(p.pose(5590f), p.pose(-10f))
    }

    @Test fun dropSnapsToNearestEdge() {
        assertEquals(Perimeter.Edge.BOTTOM, p.pose(p.nearest(500f, 1950f)).edge)
        assertEquals(450f, p.nearest(500f, 1950f))
        assertEquals(Perimeter.Edge.RIGHT, p.pose(p.nearest(990f, 1000f)).edge)
        assertEquals(950, p.pose(p.nearest(990f, 1000f)).y)
        assertEquals(Perimeter.Edge.TOP, p.pose(p.nearest(300f, 5f)).edge)
        assertEquals(250, p.pose(p.nearest(300f, 5f)).x)
        assertEquals(Perimeter.Edge.LEFT, p.pose(p.nearest(3f, 700f)).edge)
        assertEquals(650, p.pose(p.nearest(3f, 700f)).y)
    }

    @Test fun bottomOnlyModeStaysOnTheBottom() {
        val b = Perimeter(1000, 2000, 100, 90, wholeScreen = false)
        assertEquals(900f, b.length)
        assertEquals(Perimeter.Edge.BOTTOM, b.pose(3000f).edge)
        assertEquals(900, b.pose(3000f).x)
        assertEquals(250f, b.nearest(300f, 5f))
    }
}
