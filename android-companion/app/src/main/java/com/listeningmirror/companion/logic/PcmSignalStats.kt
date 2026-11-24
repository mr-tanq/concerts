package com.listeningmirror.companion.logic

import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt

data class PcmSignalStats(
    val sampleCount: Long,
    val rmsDbfs: Double,
    val peakDbfs: Double,
) {
    fun isUsable(minRmsDbfs: Double, minPeakDbfs: Double): Boolean =
        sampleCount > 0 && rmsDbfs >= minRmsDbfs && peakDbfs >= minPeakDbfs
}

object Pcm16SignalAnalyzer {
    /** Analyze signed little-endian PCM16 without changing the audio bytes. */
    fun analyze(bytes: ByteArray): PcmSignalStats {
        var i = 0
        var count = 0L
        var sumSquares = 0.0
        var peak = 0
        while (i + 1 < bytes.size) {
            val lo = bytes[i].toInt() and 0xff
            val hi = bytes[i + 1].toInt()
            val sample = ((hi shl 8) or lo).toShort().toInt()
            val magnitude = if (sample == Short.MIN_VALUE.toInt()) 32768 else abs(sample)
            if (magnitude > peak) peak = magnitude
            val normalized = sample / 32768.0
            sumSquares += normalized * normalized
            count++
            i += 2
        }
        if (count == 0L) return PcmSignalStats(0, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY)
        val rms = sqrt(sumSquares / count)
        val rmsDbfs = if (rms > 0.0) 20.0 * log10(rms) else Double.NEGATIVE_INFINITY
        val peakNorm = peak / 32768.0
        val peakDbfs = if (peakNorm > 0.0) 20.0 * log10(peakNorm) else Double.NEGATIVE_INFINITY
        return PcmSignalStats(count, rmsDbfs, peakDbfs)
    }
}
