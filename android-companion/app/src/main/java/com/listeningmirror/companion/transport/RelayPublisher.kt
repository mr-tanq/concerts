package com.listeningmirror.companion.transport

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.listeningmirror.companion.android.ProviderSnapshot
import com.listeningmirror.companion.logic.AmbientSourceSelector
import com.listeningmirror.companion.model.CurrentListeningState
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Latest publish outcome, for the settings/debug screen. */
data class PublishStatus(
    val lastAttemptAt: String?,
    val lastSuccessAt: String?,
    val lastResult: String?,
    val consecutiveFailures: Int,
    val hasSecret: Boolean,
    val lastRejectionReason: String?,
)

/**
 * Owns everything between local listening sources and the relay: source
 * arbitration, debounce, sequence allocation, heartbeat re-anchoring, retry.
 *
 * Device MediaSession playback wins over ambient recognition while playing.
 * Ambient may replace a merely paused/stopped MediaSession. The web still
 * performs the higher-level Spotify-Web-vs-Android arbitration unchanged.
 */
class RelayPublisher(context: Context) {

    private data class AnchoredState(
        val state: CurrentListeningState,
        val anchorElapsedMs: Long,
    )

    private val appContext = context.applicationContext
    private val identity = DeviceIdentity(appContext)
    private val secrets = DeviceSecretStore(appContext)

    private val thread = HandlerThread("relay-publisher").apply { start() }
    private val handler = Handler(thread.looper)

    private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    private var lastMediaState: AnchoredState? = null
    private var lastAmbientState: AnchoredState? = null

    private var retryIndex = 0
    private var consecutiveFailures = 0
    private var lastAttemptAt: String? = null
    private var lastSuccessAt: String? = null
    private var lastResult: String? = null
    private var lastRejectionReason: String? = null

    @Volatile private var running = false

    private val debounceRunnable = Runnable { publishNow(reanchorForHeartbeat = false) }
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            if (!running) return
            publishNow(reanchorForHeartbeat = true)
            handler.postDelayed(this, RelayConfig.HEARTBEAT_MS)
        }
    }

    fun start() {
        running = true
        handler.removeCallbacks(heartbeatRunnable)
        handler.postDelayed(heartbeatRunnable, RelayConfig.HEARTBEAT_MS)
    }

    fun stop() {
        running = false
        handler.removeCallbacksAndMessages(null)
        lastMediaState = null
        lastAmbientState = null
        handler.post {
            publishNow(reanchorForHeartbeat = false)
            thread.quitSafely()
        }
    }

    fun saveSecret(secret: String) = secrets.save(secret.trim())
    fun clearSecret() = secrets.clear()
    fun status(): PublishStatus = PublishStatus(
        lastAttemptAt, lastSuccessAt, lastResult, consecutiveFailures,
        secrets.hasSecret(), lastRejectionReason
    )

    /** MediaSession path, unchanged except that its state now has a sibling. */
    fun onSnapshot(snapshot: ProviderSnapshot) {
        handler.post {
            lastMediaState = snapshot.selectedState?.let {
                AnchoredState(it, SystemClock.elapsedRealtime())
            }
            scheduleDebouncedPublish()
        }
    }

    /** Ambient recognition path. Null explicitly clears the ambient candidate. */
    fun onAmbientState(state: CurrentListeningState?) {
        handler.post {
            lastAmbientState = state?.let { AnchoredState(it, SystemClock.elapsedRealtime()) }
            scheduleDebouncedPublish()
        }
    }

    private fun scheduleDebouncedPublish() {
        handler.removeCallbacks(debounceRunnable)
        handler.postDelayed(debounceRunnable, RelayConfig.DEBOUNCE_MS)
    }

    private fun selectedAnchoredState(): AnchoredState? {
        val media = lastMediaState
        val ambient = lastAmbientState
        val selected = AmbientSourceSelector.choose(media?.state, ambient?.state) ?: return null
        return when {
            media?.state === selected -> media
            ambient?.state === selected -> ambient
            else -> null
        }
    }

    private fun publishNow(reanchorForHeartbeat: Boolean) {
        val secret = secrets.load() ?: run {
            lastResult = "no secret configured"
            return
        }
        val capturedAt = isoFormat.format(Date())

        val selected = selectedAnchoredState()
        val stateToSend: CurrentListeningState? = selected?.let { anchored ->
            if (reanchorForHeartbeat) {
                val delta = SystemClock.elapsedRealtime() - anchored.anchorElapsedMs
                PositionReanchor.reanchor(anchored.state, delta, capturedAt)
            } else anchored.state
        }

        val sequence = try {
            identity.nextSequence()
        } catch (e: Exception) {
            lastResult = "sequence persistence failed: ${e.message}".take(160)
            consecutiveFailures++
            return
        }

        val envelope = JSONObject().apply {
            put("p_secret", secret)
            put("p_schema_version", RelayConfig.SCHEMA_VERSION)
            put("p_device_id", identity.deviceId)
            put("p_sequence", sequence)
            put("p_state", stateToSend?.let { StateJson.toJson(it) } ?: JSONObject.NULL)
            put("p_captured_at", stateToSend?.capturedAt ?: capturedAt)
        }

        lastAttemptAt = capturedAt
        val ok = post(envelope)
        if (ok) {
            lastSuccessAt = capturedAt
            lastRejectionReason = null
            consecutiveFailures = 0
            retryIndex = 0
        } else {
            consecutiveFailures++
            if (retryIndex < RelayConfig.RETRY_BACKOFF_MS.size) {
                val delay = RelayConfig.RETRY_BACKOFF_MS[retryIndex]
                retryIndex++
                handler.postDelayed({ publishNow(reanchorForHeartbeat = true) }, delay)
            } else {
                retryIndex = 0
            }
        }
    }

    private fun post(body: JSONObject): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(RelayConfig.PROJECT_URL + RelayConfig.PUBLISH_RPC).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("apikey", RelayConfig.ANON_KEY)
                setRequestProperty("Authorization", "Bearer " + RelayConfig.ANON_KEY)
            }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body.toString()) }
            val code = conn.responseCode
            if (code in 200..299) {
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                val accepted = try { JSONObject(text).optBoolean("accepted", false) } catch (_: Exception) { false }
                val reason = try { JSONObject(text).optString("reason", "") } catch (_: Exception) { "" }
                lastRejectionReason = if (accepted) null else reason.ifEmpty { "rejected" }
                lastResult = if (accepted) "accepted ($reason)" else "REJECTED: ${reason.ifEmpty { "unknown" }}"
                accepted
            } else {
                lastRejectionReason = null
                lastResult = "HTTP $code"
                false
            }
        } catch (e: Exception) {
            lastResult = e.message?.take(160) ?: "network error"
            false
        } finally {
            conn?.disconnect()
        }
    }
}
