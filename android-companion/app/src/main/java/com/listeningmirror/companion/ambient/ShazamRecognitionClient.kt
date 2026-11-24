package com.listeningmirror.companion.ambient

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.ThreadLocalRandom

/**
 * Unofficial, keyless Shazam recognition transport compatible with SongRec.
 * No Apple Developer account or paid API credential is used.
 *
 * This endpoint is undocumented and may change; failures are surfaced rather
 * than silently falling back to a potentially billable provider.
 */
class ShazamRecognitionClient {
    fun recognize(pcm16LeMono16kHz: ByteArray, durationMs: Long): AmbientRecognitionResult? {
        val signature = ShazamFingerprint.encodePcm16Le(pcm16LeMono16kHz)
        val timestamp = System.currentTimeMillis() / 1000L
        val rnd = ThreadLocalRandom.current()
        val firstUuid = UUID.randomUUID().toString().uppercase()
        val secondUuid = UUID.randomUUID().toString()
        val endpoint = buildString {
            append("https://amp.shazam.com/discovery/v5/en/US/android/-/tag/")
            append(firstUuid).append('/').append(secondUuid)
            append("?sync=true&webv3=true&sampling=true&connected=")
            append("&shazamapiversion=v3&sharehub=true&video=v3")
        }

        val body = JSONObject()
            .put("geolocation", JSONObject()
                // Synthetic coarse coordinates: the recognizer does not need
                // the user's real location and Listening Mirror never reads it.
                .put("altitude", rnd.nextDouble(100.0, 500.0))
                .put("latitude", rnd.nextDouble(-85.0, 85.0))
                .put("longitude", rnd.nextDouble(-175.0, 175.0)))
            .put("signature", JSONObject()
                .put("samplems", durationMs)
                .put("timestamp", timestamp)
                .put("uri", signature))
            .put("timestamp", timestamp)
            .put("timezone", TimeZone.getDefault().id.takeIf { it.isNotBlank() } ?: "Europe/Amsterdam")
            .toString()
            .toByteArray(Charsets.UTF_8)

        var conn: HttpURLConnection? = null
        try {
            conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 12_000
                readTimeout = 20_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Content-Language", "en_US")
                setRequestProperty("User-Agent", USER_AGENT)
                setFixedLengthStreamingMode(body.size)
            }
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                val detail = text.take(180).replace('\n', ' ')
                if (code == 429) error("Shazam rate limit (HTTP 429)")
                error("Shazam HTTP $code${if (detail.isBlank()) "" else ": $detail"}")
            }
            if (text.isBlank()) error("Shazam returned an empty response")
            return parse(JSONObject(text))
        } finally {
            conn?.disconnect()
        }
    }

    private fun parse(root: JSONObject): AmbientRecognitionResult? {
        val track = root.optJSONObject("track") ?: return null
        val title = track.optString("title").trim().takeIf { it.isNotEmpty() } ?: return null
        val artist = track.optString("subtitle").trim().takeIf { it.isNotEmpty() } ?: return null

        val match = root.optJSONArray("matches")?.firstObject()
        val offsetSeconds = match?.optDouble("offset", Double.NaN)
            ?.takeIf { it.isFinite() && it >= 0.0 }
        val positionMs = offsetSeconds?.let { (it * 1000.0).toLong() }

        val images = track.optJSONObject("images")
        val artwork = sequenceOf("coverarthq", "background", "coverart")
            .mapNotNull { key -> images?.optString(key)?.trim()?.takeIf(::browserSafe) }
            .firstOrNull()
            ?.resizeArtwork("1500x1500cc")

        val album = track.optJSONArray("sections")
            ?.objects()
            ?.firstOrNull { it.optString("type").equals("SONG", ignoreCase = true) }
            ?.optJSONArray("metadata")
            ?.objects()
            ?.firstOrNull { it.optString("title").equals("ALBUM", ignoreCase = true) }
            ?.optString("text")
            ?.trim()
            ?.takeIf { it.isNotEmpty() }

        val key = track.optString("key").trim().takeIf { it.isNotEmpty() }
        val shareUrl = track.optJSONObject("share")?.optString("href")?.trim()?.takeIf(::browserSafe)
        val trackUrl = track.optString("url").trim().takeIf(::browserSafe)

        return AmbientRecognitionResult(
            artist = artist,
            title = title,
            album = album,
            artworkUrl = artwork,
            durationMs = null,
            positionMs = positionMs,
            externalId = key?.let { "shazam:$it" },
            externalUrl = trackUrl ?: shareUrl,
        )
    }

    private fun JSONArray.firstObject(): JSONObject? =
        if (length() > 0) optJSONObject(0) else null

    private fun JSONArray.objects(): Sequence<JSONObject> = sequence {
        for (i in 0 until length()) {
            val obj = optJSONObject(i)
            if (obj != null) yield(obj)
        }
    }

    private fun String.resizeArtwork(size: String): String {
        val regex = Regex("\\d+x\\d+cc")
        return if (regex.containsMatchIn(this)) regex.replace(this, size) else this
    }

    private fun browserSafe(value: String?): Boolean =
        value?.startsWith("https://", ignoreCase = true) == true ||
            value?.startsWith("http://", ignoreCase = true) == true

    private companion object {
        // A conventional Android/Dalvik UA accepted by the same endpoint used
        // by SongRec-compatible clients. It contains no user/device identifier.
        const val USER_AGENT =
            "Dalvik/2.1.0 (Linux; U; Android 6.0.1; SM-G920F Build/MMB29K)"
    }
}
