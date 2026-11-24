package com.listeningmirror.companion.ambient

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream

object PcmWav {
    fun encode16BitMono(pcm: ByteArray, sampleRate: Int): ByteArray {
        val out = ByteArrayOutputStream(44 + pcm.size)
        val data = DataOutputStream(out)
        fun le16(v: Int) {
            data.writeByte(v and 0xff)
            data.writeByte((v ushr 8) and 0xff)
        }
        fun le32(v: Int) {
            data.writeByte(v and 0xff)
            data.writeByte((v ushr 8) and 0xff)
            data.writeByte((v ushr 16) and 0xff)
            data.writeByte((v ushr 24) and 0xff)
        }
        data.writeBytes("RIFF")
        le32(36 + pcm.size)
        data.writeBytes("WAVE")
        data.writeBytes("fmt ")
        le32(16)
        le16(1) // PCM
        le16(1) // mono
        le32(sampleRate)
        le32(sampleRate * 2)
        le16(2)
        le16(16)
        data.writeBytes("data")
        le32(pcm.size)
        data.write(pcm)
        data.flush()
        return out.toByteArray()
    }
}
