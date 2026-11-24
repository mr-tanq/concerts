package com.listeningmirror.companion.ambient

import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.zip.CRC32
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.sin

/**
 * Pure-Kotlin implementation of the Shazam/SongRec fingerprint format.
 *
 * Input must be signed PCM16 little-endian, mono, 16 kHz. The algorithm is
 * compatible with the public SongRec reverse-engineering work. Keeping this
 * implementation in Kotlin avoids an NDK/Rust build step in the Companion.
 */
object ShazamFingerprint {
    const val SAMPLE_RATE_HZ = 16_000
    private const val FFT_SIZE = 2048
    private const val FFT_HOP = 128
    private const val FFT_RING = 256
    private const val FFT_BINS = 1025
    private const val DATA_URI_PREFIX = "data:audio/vnd.shazam.sig;base64,"

    private val hanning = FloatArray(FFT_SIZE) { i ->
        // Equivalent to numpy.hanning(2050)[1:-1], used by SongRec.
        (0.5 * (1.0 - cos(2.0 * PI * (i + 1).toDouble() / 2049.0))).toFloat()
    }

    private val fftTwiddleRe = FloatArray(FFT_SIZE / 2) { k ->
        cos(-2.0 * PI * k.toDouble() / FFT_SIZE.toDouble()).toFloat()
    }
    private val fftTwiddleIm = FloatArray(FFT_SIZE / 2) { k ->
        sin(-2.0 * PI * k.toDouble() / FFT_SIZE.toDouble()).toFloat()
    }

    data class Peak(
        val fftPassNumber: Int,
        val magnitude: Int,
        val correctedFrequencyBin: Int,
    )

    fun encodePcm16Le(pcm: ByteArray): String {
        require(pcm.isNotEmpty() && pcm.size % 2 == 0) { "PCM16 input must be non-empty and even-sized" }
        return encodeSamples(toShortArray(pcm))
    }

    fun encodeSamples(samples: ShortArray): String {
        require(samples.size >= SAMPLE_RATE_HZ * 2) { "Shazam sample must be at least 2 seconds" }
        val signature = Generator(samples).generate()
        val binary = encodeBinary(samples.size, signature)
        return DATA_URI_PREFIX + Base64.getEncoder().encodeToString(binary)
    }

    private fun toShortArray(pcm: ByteArray): ShortArray = ShortArray(pcm.size / 2) { i ->
        val lo = pcm[i * 2].toInt() and 0xff
        val hi = pcm[i * 2 + 1].toInt()
        ((hi shl 8) or lo).toShort()
    }

    private class Generator(private val samples: ShortArray) {
        private val sampleRing = ShortArray(FFT_SIZE)
        private var sampleRingIndex = 0
        private val reordered = FloatArray(FFT_SIZE)
        private val fftImag = FloatArray(FFT_SIZE)
        private val fftOutputs = Array(FFT_RING) { FloatArray(FFT_BINS) }
        private var fftIndex = 0
        private val spreadOutputs = Array(FFT_RING) { FloatArray(FFT_BINS) }
        private var spreadIndex = 0
        private var numSpreadFfts = 0
        private val bands = Array(4) { mutableListOf<Peak>() }

        fun generate(): Array<MutableList<Peak>> {
            var offset = 0
            while (offset + FFT_HOP <= samples.size) {
                doFft(samples, offset)
                doPeakSpreading()
                numSpreadFfts += 1
                if (numSpreadFfts >= 46) doPeakRecognition()
                offset += FFT_HOP
            }
            return bands
        }

        private fun doFft(input: ShortArray, offset: Int) {
            for (i in 0 until FFT_HOP) sampleRing[sampleRingIndex + i] = input[offset + i]
            sampleRingIndex = (sampleRingIndex + FFT_HOP) and (FFT_SIZE - 1)

            for (i in 0 until FFT_SIZE) {
                reordered[i] = sampleRing[(i + sampleRingIndex) and (FFT_SIZE - 1)].toFloat() * hanning[i]
                fftImag[i] = 0f
            }
            fftInPlace(reordered, fftImag)

            val out = fftOutputs[fftIndex]
            for (i in 0 until FFT_BINS) {
                val re = reordered[i]
                val im = fftImag[i]
                out[i] = ((re * re + im * im) / 131_072f).coerceAtLeast(1e-10f)
            }
            fftIndex = (fftIndex + 1) and 255
        }

        private fun doPeakSpreading() {
            val origin = fftOutputs[(fftIndex - 1) and 255]
            val spread = spreadOutputs[spreadIndex]
            System.arraycopy(origin, 0, spread, 0, FFT_BINS)

            for (position in 0..1022) {
                var v = spread[position]
                if (spread[position + 1] > v) v = spread[position + 1]
                if (spread[position + 2] > v) v = spread[position + 2]
                spread[position] = v
            }

            val currentCopy = spread.copyOf()
            for (position in 0 until FFT_BINS) {
                val current = currentCopy[position]
                for (former in intArrayOf(1, 3, 6)) {
                    val target = spreadOutputs[(spreadIndex - former) and 255]
                    if (current > target[position]) target[position] = current
                }
            }
            spreadIndex = (spreadIndex + 1) and 255
        }

        private fun doPeakRecognition() {
            val fftMinus46 = fftOutputs[(fftIndex - 46) and 255]
            val fftMinus49 = spreadOutputs[(spreadIndex - 49) and 255]

            for (bin in 10..1014) {
                val center = fftMinus46[bin]
                if (center < 1f / 64f || center < fftMinus49[bin - 1]) continue

                var neighborMax = 0f
                for (delta in intArrayOf(-10, -7, -4, -3, 1, 2, 5, 8)) {
                    val v = fftMinus49[bin + delta]
                    if (v > neighborMax) neighborMax = v
                }
                if (center <= neighborMax) continue

                var temporalMax = neighborMax
                for (offset in intArrayOf(-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249)) {
                    val other = spreadOutputs[(spreadIndex + offset) and 255]
                    val v = other[bin - 1]
                    if (v > temporalMax) temporalMax = v
                }
                if (center <= temporalMax) continue

                val fftPass = numSpreadFfts - 46
                val mag = encodedMagnitude(center)
                val magBefore = encodedMagnitude(fftMinus46[bin - 1])
                val magAfter = encodedMagnitude(fftMinus46[bin + 1])
                val variation1 = mag * 2f - magBefore - magAfter
                if (!(variation1 > 0f)) continue
                val variation2 = (magAfter - magBefore) * 32f / variation1
                val corrected = (bin * 64 + variation2.toInt()).coerceIn(0, 65_535)
                val frequencyHz = corrected * (SAMPLE_RATE_HZ.toFloat() / 2f / 1024f / 64f)
                val band = when (frequencyHz.toInt()) {
                    in 250..519 -> 0
                    in 520..1449 -> 1
                    in 1450..3499 -> 2
                    in 3500..5500 -> 3
                    else -> -1
                }
                if (band >= 0) {
                    bands[band].add(Peak(fftPass, mag.toInt().coerceIn(0, 65_535), corrected))
                }
            }
        }

        private fun encodedMagnitude(value: Float): Float =
            (ln(value.coerceAtLeast(1f / 64f).toDouble()) * 1477.3 + 6144.0).toFloat()
    }

    /** Standard unnormalised radix-2 complex FFT; real input is supplied in [re]. */
    private fun fftInPlace(re: FloatArray, im: FloatArray) {
        val n = re.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j xor bit
            if (i < j) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }

        var len = 2
        while (len <= n) {
            val half = len shr 1
            val twiddleStride = n / len
            var base = 0
            while (base < n) {
                for (k in 0 until half) {
                    val twiddleIndex = k * twiddleStride
                    val wRe = fftTwiddleRe[twiddleIndex]
                    val wIm = fftTwiddleIm[twiddleIndex]
                    val even = base + k
                    val odd = even + half
                    val oddRe = re[odd] * wRe - im[odd] * wIm
                    val oddIm = re[odd] * wIm + im[odd] * wRe
                    val evenRe = re[even]
                    val evenIm = im[even]
                    re[even] = evenRe + oddRe
                    im[even] = evenIm + oddIm
                    re[odd] = evenRe - oddRe
                    im[odd] = evenIm - oddIm
                }
                base += len
            }
            len = len shl 1
        }
    }

    private fun encodeBinary(numberSamples: Int, bands: Array<MutableList<Peak>>): ByteArray {
        val contents = ByteArrayOutputStream()
        for (band in 0..3) {
            val peaks = bands[band]
            if (peaks.isEmpty()) continue
            val peakBytes = ByteArrayOutputStream()
            var lastFft = 0
            for (peak in peaks) {
                require(peak.fftPassNumber >= lastFft)
                if (peak.fftPassNumber - lastFft >= 255) {
                    peakBytes.write(0xff)
                    writeU32Le(peakBytes, peak.fftPassNumber.toLong())
                    lastFft = peak.fftPassNumber
                }
                peakBytes.write(peak.fftPassNumber - lastFft)
                writeU16Le(peakBytes, peak.magnitude)
                writeU16Le(peakBytes, peak.correctedFrequencyBin)
                lastFft = peak.fftPassNumber
            }
            val payload = peakBytes.toByteArray()
            writeU32Le(contents, 0x60030040L + band)
            writeU32Le(contents, payload.size.toLong())
            contents.write(payload)
            repeat((4 - payload.size % 4) % 4) { contents.write(0) }
        }

        val contentBytes = contents.toByteArray()
        val out = ByteArrayOutputStream(56 + contentBytes.size)
        writeU32Le(out, 0xcafe2580L)
        writeU32Le(out, 0L) // crc patched below
        writeU32Le(out, (contentBytes.size + 8).toLong())
        writeU32Le(out, 0x94119c00L)
        repeat(3) { writeU32Le(out, 0L) }
        writeU32Le(out, 3L shl 27) // 16 kHz sample-rate id
        repeat(2) { writeU32Le(out, 0L) }
        writeU32Le(out, numberSamples.toLong() + (SAMPLE_RATE_HZ * 0.24).toLong())
        writeU32Le(out, ((15 shl 19) + 0x40000).toLong())
        writeU32Le(out, 0x40000000L)
        writeU32Le(out, (contentBytes.size + 8).toLong())
        out.write(contentBytes)

        val bytes = out.toByteArray()
        val crc = CRC32().apply { update(bytes, 8, bytes.size - 8) }.value
        patchU32Le(bytes, 4, crc)
        return bytes
    }

    private fun writeU16Le(out: ByteArrayOutputStream, value: Int) {
        out.write(value and 0xff)
        out.write((value ushr 8) and 0xff)
    }

    private fun writeU32Le(out: ByteArrayOutputStream, value: Long) {
        out.write((value and 0xff).toInt())
        out.write(((value ushr 8) and 0xff).toInt())
        out.write(((value ushr 16) and 0xff).toInt())
        out.write(((value ushr 24) and 0xff).toInt())
    }

    private fun patchU32Le(bytes: ByteArray, offset: Int, value: Long) {
        bytes[offset] = (value and 0xff).toByte()
        bytes[offset + 1] = ((value ushr 8) and 0xff).toByte()
        bytes[offset + 2] = ((value ushr 16) and 0xff).toByte()
        bytes[offset + 3] = ((value ushr 24) and 0xff).toByte()
    }
}
