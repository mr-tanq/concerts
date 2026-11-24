package com.listeningmirror.companion.ambient

import com.listeningmirror.companion.logic.AmbientTimecode
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/** Minimal direct client for AudD's documented standard multipart endpoint. */
class AudDRecognitionClient {
    fun recognize(wav: ByteArray, apiToken: String): AmbientRecognitionResult? {
        val boundary = "----ListeningMirror${System.nanoTime()}"
        val body = multipart(boundary, wav, apiToken)
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(API_URL).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 30_000
                doOutput = true
                setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                setRequestProperty("Accept", "application/json")
                setFixedLengthStreamingMode(body.size)
            }
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (text.isBlank()) error("AudD HTTP $code with empty response")
            val root = JSONObject(text)
            if (root.optString("status") != "success") {
                val err = root.optJSONObject("error")
                val codeValue = err?.optInt("error_code", -1)?.takeIf { it >= 0 }
                val message = err?.optString("error_message")?.takeIf { it.isNotBlank() }
                    ?: root.optString("error").takeIf { it.isNotBlank() }
                    ?: "AudD request failed"
                error(buildString {
                    append(message)
                    if (codeValue != null) append(" (#").append(codeValue).append(')')
                })
            }
            if (root.isNull("result")) return null
            return parseResult(root.getJSONObject("result"))
        } finally {
            conn?.disconnect()
        }
    }

    private fun parseResult(r: JSONObject): AmbientRecognitionResult? {
        val artist = r.optString("artist").trim().takeIf { it.isNotEmpty() } ?: return null
        val title = r.optString("title").trim().takeIf { it.isNotEmpty() } ?: return null
        val spotify = r.optJSONObject("spotify")
        val spotifyAlbum = spotify?.optJSONObject("album")
        val apple = r.optJSONObject("apple_music")

        val album = spotifyAlbum?.optString("name")?.trim()?.takeIf { it.isNotEmpty() }
            ?: r.optString("album").trim().takeIf { it.isNotEmpty() }

        val spotifyArtwork = spotifyAlbum?.optJSONArray("images")
            ?.takeIf { it.length() > 0 }
            ?.optJSONObject(0)
            ?.optString("url")
            ?.takeIf(::browserSafe)

        val appleArtwork = apple?.optJSONObject("artwork")
            ?.optString("url")
            ?.takeIf { it.isNotBlank() }
            ?.replace("{w}", "600")
            ?.replace("{h}", "600")
            ?.takeIf(::browserSafe)

        val duration = spotify?.optLong("duration_ms", -1L)?.takeIf { it > 0L }
            ?: apple?.optLong("durationInMillis", -1L)?.takeIf { it > 0L }
        val rawPosition = AmbientTimecode.parseMs(r.optString("timecode"))
        val position = when {
            rawPosition == null -> null
            duration != null -> rawPosition.coerceIn(0L, duration)
            else -> rawPosition
        }

        val spotifyId = spotify?.optString("id")?.trim()?.takeIf { it.isNotEmpty() }
        val songLink = r.optString("song_link").trim().takeIf(::browserSafe)
        val spotifyUrl = spotify?.optJSONObject("external_urls")
            ?.optString("spotify")?.trim()?.takeIf(::browserSafe)
        val appleUrl = apple?.optString("url")?.trim()?.takeIf(::browserSafe)

        return AmbientRecognitionResult(
            artist = artist,
            title = title,
            album = album,
            artworkUrl = spotifyArtwork ?: appleArtwork,
            durationMs = duration,
            positionMs = position,
            externalId = spotifyId?.let { "spotify:$it" } ?: songLink,
            externalUrl = spotifyUrl ?: appleUrl ?: songLink,
        )
    }

    private fun multipart(boundary: String, wav: ByteArray, token: String): ByteArray {
        val out = ByteArrayOutputStream(wav.size + 1024)
        fun text(name: String, value: String) {
            out.write("--$boundary\r\n".toByteArray())
            out.write("Content-Disposition: form-data; name=\"$name\"\r\n\r\n".toByteArray())
            out.write(value.toByteArray(Charsets.UTF_8))
            out.write("\r\n".toByteArray())
        }
        text("api_token", token)
        text("return", "apple_music,spotify")
        val market = Locale.getDefault().country.uppercase(Locale.US).takeIf { it.length == 2 } ?: "US"
        text("market", market)
        out.write("--$boundary\r\n".toByteArray())
        out.write("Content-Disposition: form-data; name=\"file\"; filename=\"ambient.wav\"\r\n".toByteArray())
        out.write("Content-Type: audio/wav\r\n\r\n".toByteArray())
        out.write(wav)
        out.write("\r\n--$boundary--\r\n".toByteArray())
        return out.toByteArray()
    }

    private fun browserSafe(value: String?): Boolean =
        value?.startsWith("https://", ignoreCase = true) == true ||
            value?.startsWith("http://", ignoreCase = true) == true

    companion object {
        const val API_URL = "https://api.audd.io/"
    }
}
