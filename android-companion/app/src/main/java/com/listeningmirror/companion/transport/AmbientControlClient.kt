package com.listeningmirror.companion.transport

import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/** One control-plane snapshot fetched by the Companion. */
data class AmbientControlCommand(
    val present: Boolean,
    val desiredEnabled: Boolean,
    val commandSequence: Long,
)

/**
 * Tiny RPC client for Phase 2C remote ambient control.
 *
 * Uses the SAME device write secret already stored in Android Keystore. The
 * server-side RPC only accepts capability='write', so no new credential is
 * compiled into or persisted by the APK.
 */
class AmbientControlClient {

    fun read(writeSecret: String): AmbientControlCommand? {
        val body = JSONObject().apply { put("p_secret", writeSecret) }
        val json = post(RelayConfig.AMBIENT_CONTROL_READ_RPC, body) ?: return null
        if (!json.optBoolean("ok", false)) return null
        if (!json.optBoolean("present", false)) {
            return AmbientControlCommand(false, false, 0L)
        }
        return AmbientControlCommand(
            present = true,
            desiredEnabled = json.optBoolean("desired_enabled", false),
            commandSequence = json.optLong("command_sequence", 0L),
        )
    }

    fun ack(
        writeSecret: String,
        commandSequence: Long,
        enabled: Boolean,
        deviceId: String,
    ): Boolean {
        val body = JSONObject().apply {
            put("p_secret", writeSecret)
            put("p_command_sequence", commandSequence)
            put("p_enabled", enabled)
            put("p_device_id", deviceId)
        }
        val json = post(RelayConfig.AMBIENT_CONTROL_ACK_RPC, body) ?: return false
        return json.optBoolean("ok", false)
    }

    private fun post(path: String, body: JSONObject): JSONObject? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(RelayConfig.PROJECT_URL + path).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("apikey", RelayConfig.ANON_KEY)
                setRequestProperty("Authorization", "Bearer " + RelayConfig.ANON_KEY)
            }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body.toString()) }
            if (conn.responseCode !in 200..299) return null
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            JSONObject(text)
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }
}
