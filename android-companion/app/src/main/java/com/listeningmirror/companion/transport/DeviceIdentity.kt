package com.listeningmirror.companion.transport

import android.content.Context
import java.io.File
import java.util.UUID

/**
 * Per-install device id and publish sequence.
 *
 * Stored under context.noBackupFilesDir DELIBERATELY, not SharedPreferences.
 * Android Auto Backup would otherwise restore a previous install's deviceId
 * and sequence counter onto a fresh install -- resurrecting a stale identity
 * whose high sequence number would then silently reject the new install's
 * own publishes (which correctly restart at 1). Excluding these from backup
 * gives the required lifecycle:
 *
 *     reinstall / cleared data -> new deviceId -> fresh sequence space
 *
 * Sequence allocation is synchronized and writes the file before returning,
 * so two concurrent publishes can never reuse or reorder a sequence value.
 */
class DeviceIdentity(context: Context) {

    private val dir = File(context.noBackupFilesDir, "transport").apply { mkdirs() }
    private val idFile = File(dir, "device_id")
    private val seqFile = File(dir, "sequence")
    private val lock = Any()

    val deviceId: String by lazy {
        synchronized(lock) {
            if (idFile.exists()) {
                idFile.readText().trim().ifEmpty { newDeviceId() }
            } else {
                newDeviceId()
            }
        }
    }

    private fun newDeviceId(): String {
        val id = UUID.randomUUID().toString()
        idFile.writeText(id)
        return id
    }

    /**
     * Atomically allocate the next sequence. Synchronized AND durable before
     * returning: an in-memory counter alone would hand out duplicates across
     * a process restart, and an unsynchronized one would race between the
     * debounced publish and the heartbeat.
     */
    fun nextSequence(): Long {
        synchronized(lock) {
            val current = if (seqFile.exists()) seqFile.readText().trim().toLongOrNull() ?: 0L else 0L
            val next = current + 1
            val tmp = File(dir, "sequence.tmp")
            tmp.writeText(next.toString())
            // FAIL CLOSED. renameTo returns false rather than throwing, and
            // ignoring it would hand out a sequence that never reached disk --
            // after a restart the counter would rewind and reuse values, which
            // the relay would then correctly reject as stale, silently
            // wedging publishing. Better to fail the publish loudly now.
            if (!tmp.renameTo(seqFile)) {
                tmp.delete()
                throw java.io.IOException("Could not durably persist sequence $next")
            }
            return next
        }
    }
}
