package com.listeningmirror.companion.ambient

import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import com.listeningmirror.companion.logic.Pcm16SignalAnalyzer
import com.listeningmirror.companion.logic.PcmSignalStats
import java.io.ByteArrayOutputStream

data class AmbientCapture(
    val wav: ByteArray,
    val pcm16Le: ByteArray,
    val stats: PcmSignalStats,
    val sampleRateHz: Int,
    val durationMs: Long,
    val audioSourceName: String,
) {
    fun diagnostic(): String = buildString {
        append(sampleRateHz / 1000.0).append(" kHz · ")
        append(durationMs / 1000.0).append(" s · ")
        append(audioSourceName)
        append(" · RMS ").append(formatDb(stats.rmsDbfs)).append(" dBFS")
        append(" · peak ").append(formatDb(stats.peakDbfs)).append(" dBFS")
    }

    private fun formatDb(value: Double): String =
        if (value.isFinite()) String.format(java.util.Locale.US, "%.1f", value) else "-inf"
}

class AmbientAudioRecorder(context: Context) {
    private val appContext = context.applicationContext
    @Volatile private var active: AudioRecord? = null

    fun captureWav(
        durationMs: Long = AmbientConfig.SAMPLE_DURATION_MS,
        sampleRateHz: Int = AmbientConfig.SAMPLE_RATE_HZ,
    ): AmbientCapture {
        val source = preferredAudioSource()
        val minBuffer = AudioRecord.getMinBufferSize(
            sampleRateHz,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minBuffer > 0) { "AudioRecord buffer unavailable: $minBuffer" }
        val bufferSize = maxOf(minBuffer, 8192)
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRateHz)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()
        val recorder = AudioRecord.Builder()
            .setAudioSource(source.first)
            .setAudioFormat(format)
            .setBufferSizeInBytes(bufferSize * 2)
            .build()
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            error("AudioRecord failed to initialize (${source.second})")
        }

        active = recorder
        val bytesNeeded = ((sampleRateHz * 2L * durationMs) / 1000L).toInt()
        val pcm = ByteArrayOutputStream(bytesNeeded)
        val buf = ByteArray(bufferSize)
        try {
            recorder.startRecording()
            while (pcm.size() < bytesNeeded && !Thread.currentThread().isInterrupted) {
                val want = minOf(buf.size, bytesNeeded - pcm.size())
                val n = recorder.read(buf, 0, want, AudioRecord.READ_BLOCKING)
                if (n > 0) pcm.write(buf, 0, n)
                else if (n < 0) error("AudioRecord read failed: $n")
            }
        } finally {
            runCatching { if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop() }
            recorder.release()
            active = null
        }
        if (pcm.size() < bytesNeeded / 2) error("Audio capture ended too early")
        val pcmBytes = pcm.toByteArray()
        return AmbientCapture(
            wav = PcmWav.encode16BitMono(pcmBytes, sampleRateHz),
            pcm16Le = pcmBytes,
            stats = Pcm16SignalAnalyzer.analyze(pcmBytes),
            sampleRateHz = sampleRateHz,
            durationMs = durationMs,
            audioSourceName = source.second,
        )
    }

    /** Android's documented preference for raw capture, with documented fallback. */
    private fun preferredAudioSource(): Pair<Int, String> {
        val manager = appContext.getSystemService(AudioManager::class.java)
        val rawSupported = manager
            ?.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED)
            ?.equals("true", ignoreCase = true) == true
        return if (rawSupported) {
            MediaRecorder.AudioSource.UNPROCESSED to "UNPROCESSED"
        } else {
            MediaRecorder.AudioSource.VOICE_RECOGNITION to "VOICE_RECOGNITION"
        }
    }

    fun cancel() {
        val r = active ?: return
        runCatching { r.stop() }
    }
}
