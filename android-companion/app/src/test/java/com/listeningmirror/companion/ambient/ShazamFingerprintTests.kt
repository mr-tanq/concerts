package com.listeningmirror.companion.ambient

import java.util.Base64
import java.util.zip.CRC32
import kotlin.math.PI
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ShazamFingerprintTests {
    @Test
    fun deterministicThreeSecondSignalProducesStructurallyValidPacket() {
        val samples = syntheticSignal(seconds = 3)
        val first = ShazamFingerprint.encodeSamples(samples)
        val second = ShazamFingerprint.encodeSamples(samples)

        assertEquals(first, second)
        assertTrue(first.startsWith(PREFIX))

        val packet = Base64.getDecoder().decode(first.removePrefix(PREFIX))
        assertTrue(packet.size > 56, "Fingerprint should contain peak payload")
        assertEquals(0xcafe2580L, u32(packet, 0))
        assertEquals(0x94119c00L, u32(packet, 12))
        assertEquals(3L shl 27, u32(packet, 28), "Shazam sample-rate id must be 16 kHz")
        assertEquals(samples.size.toLong() + (16_000 * 0.24).toLong(), u32(packet, 40))
        assertEquals(packet.size.toLong() - 48L, u32(packet, 8))
        assertEquals(packet.size.toLong() - 48L, u32(packet, 52))

        val expectedCrc = CRC32().apply { update(packet, 8, packet.size - 8) }.value
        assertEquals(expectedCrc, u32(packet, 4))
    }

    @Test
    fun pcmLittleEndianEntryPointMatchesShortArrayEntryPoint() {
        val samples = syntheticSignal(seconds = 3)
        val pcm = ByteArray(samples.size * 2)
        samples.forEachIndexed { i, sample ->
            val value = sample.toInt()
            pcm[i * 2] = (value and 0xff).toByte()
            pcm[i * 2 + 1] = ((value ushr 8) and 0xff).toByte()
        }
        assertEquals(ShazamFingerprint.encodeSamples(samples), ShazamFingerprint.encodePcm16Le(pcm))
    }

    @Test
    fun sampleShorterThanTwoSecondsIsRejectedLocally() {
        assertFailsWith<IllegalArgumentException> {
            ShazamFingerprint.encodeSamples(ShortArray(16_000))
        }
    }

    private fun syntheticSignal(seconds: Int): ShortArray {
        val count = seconds * 16_000
        return ShortArray(count) { i ->
            val t = i.toDouble() / 16_000.0
            val value =
                0.36 * sin(2.0 * PI * 440.0 * t) +
                0.23 * sin(2.0 * PI * 987.0 * t) +
                0.16 * sin(2.0 * PI * 2130.0 * t) +
                0.09 * sin(2.0 * PI * (300.0 + 300.0 * t) * t)
            (value * 32767.0).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }
    }

    private fun u32(bytes: ByteArray, offset: Int): Long =
        (bytes[offset].toLong() and 0xffL) or
            ((bytes[offset + 1].toLong() and 0xffL) shl 8) or
            ((bytes[offset + 2].toLong() and 0xffL) shl 16) or
            ((bytes[offset + 3].toLong() and 0xffL) shl 24)

    private companion object {
        const val PREFIX = "data:audio/vnd.shazam.sig;base64,"
    }
}
