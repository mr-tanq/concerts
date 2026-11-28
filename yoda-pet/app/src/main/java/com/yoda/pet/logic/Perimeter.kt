package com.yoda.pet.logic

/**
 * The path Yoda walks: along the bottom, up the right edge, along the top
 * and down the left edge, feet always against the edge. Positions are in
 * the overlay's frame (the screen minus status and navigation bars).
 *
 * [w] x [h] is Yoda's window upright; on the side edges it is turned
 * sideways (h x w). Position p grows counter-clockwise: right along the
 * bottom, up the right side, left along the top, down the left side.
 */
class Perimeter(
    val areaW: Int,
    val areaH: Int,
    val w: Int,
    val h: Int,
    val wholeScreen: Boolean,
) {
    /** Window position, size and rotation (degrees, clockwise) of the art inside it. */
    data class Pose(val x: Int, val y: Int, val winW: Int, val winH: Int, val rotation: Int, val edge: Edge)

    enum class Edge { BOTTOM, RIGHT, TOP, LEFT }

    private val lb = (areaW - w).coerceAtLeast(0).toFloat()   // bottom / top run
    private val lv = (areaH - w).coerceAtLeast(0).toFloat()   // side run

    val length: Float = if (wholeScreen) 2 * lb + 2 * lv else lb

    /** Wraps (whole screen) or clamps (bottom only) a position onto the path. */
    fun normalize(p: Float): Float =
        if (!wholeScreen || length <= 0f) p.coerceIn(0f, lb)
        else ((p % length) + length) % length

    fun pose(p0: Float): Pose {
        val p = normalize(p0)
        if (!wholeScreen || p < lb) return Pose(p.toInt(), areaH - h, w, h, 0, Edge.BOTTOM)
        var t = p - lb
        if (t < lv) return Pose(areaW - h, (lv - t).toInt(), h, w, -90, Edge.RIGHT)
        t -= lv
        if (t < lb) return Pose((lb - t).toInt(), 0, w, h, 180, Edge.TOP)
        t -= lb
        return Pose(0, t.coerceAtMost(lv).toInt(), h, w, 90, Edge.LEFT)
    }

    /** Where Yoda lands when dropped with his middle at (cx, cy): the nearest edge. */
    fun nearest(cx: Float, cy: Float): Float {
        if (!wholeScreen) return (cx - w / 2f).coerceIn(0f, lb)
        val dBottom = areaH - cy
        val dRight = areaW - cx
        val dTop = cy
        val dLeft = cx
        val min = minOf(minOf(dBottom, dRight), minOf(dTop, dLeft))
        return when (min) {
            dBottom -> (cx - w / 2f).coerceIn(0f, lb)
            dRight -> lb + (lv - (cy - w / 2f)).coerceIn(0f, lv)
            dTop -> lb + lv + (lb - (cx - w / 2f)).coerceIn(0f, lb)
            else -> 2 * lb + lv + (cy - w / 2f).coerceIn(0f, lv)
        }
    }

    companion object {
        /** Screen offset for a jump of [height] px away from the edge Yoda stands on. */
        fun jumpOffset(edge: Edge, height: Int): Pair<Int, Int> = when (edge) {
            Edge.BOTTOM -> 0 to -height
            Edge.RIGHT -> -height to 0
            Edge.TOP -> 0 to height
            Edge.LEFT -> height to 0
        }
    }
}
