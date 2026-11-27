package com.yoda.pet

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.yoda.pet.logic.Pkce
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Spotify Web API with PKCE sign-in (no client secret, no Spotify SDK).
 * "Favourites" are your Liked Songs; if you have none, your top tracks.
 */
class SpotifyClient(context: Context) {
    private val ctx = context.applicationContext
    private val prefs = Prefs(ctx)

    data class Track(val uri: String, val name: String, val artists: String)

    sealed class PlayResult {
        data class Playing(val track: Track) : PlayResult()
        /** Couldn't start playback through the API (e.g. Free account), so the song was opened in Spotify. */
        data class Opened(val track: Track) : PlayResult()
        data class Failed(val message: String) : PlayResult()
    }

    class SpotifyException(val code: Int, message: String) : Exception(message)

    companion object {
        const val REDIRECT_URI = "yoda-pet://spotify-callback"
        private const val SCOPES = "user-library-read user-top-read user-read-playback-state user-modify-playback-state"
        private const val API = "https://api.spotify.com/v1"
        private val io = Executors.newSingleThreadExecutor()
        private val clientId get() = BuildConfig.SPOTIFY_CLIENT_ID
    }

    val isConnected: Boolean get() = prefs.spotifyRefresh != null

    // ---------- sign-in ----------

    fun authorizeUri(): Uri {
        val verifier = Pkce.newVerifier()
        val state = UUID.randomUUID().toString()
        prefs.spotifyVerifier = verifier
        prefs.spotifyState = state
        return Uri.parse("https://accounts.spotify.com/authorize").buildUpon()
            .appendQueryParameter("client_id", clientId)
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("redirect_uri", REDIRECT_URI)
            .appendQueryParameter("scope", SCOPES)
            .appendQueryParameter("state", state)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("code_challenge", Pkce.challenge(verifier))
            .build()
    }

    /** Finishes sign-in from the redirect. Blocking — call off the main thread. */
    fun finishSignIn(redirect: Uri): Result<String> = runCatching {
        redirect.getQueryParameter("error")?.let { throw Exception("Spotify said: $it") }
        val code = redirect.getQueryParameter("code") ?: throw Exception("No code in the Spotify reply")
        if (redirect.getQueryParameter("state") != prefs.spotifyState) throw Exception("Sign-in expired, please try again")
        val verifier = prefs.spotifyVerifier ?: throw Exception("Sign-in expired, please try again")
        val json = tokenRequest(
            "grant_type" to "authorization_code",
            "code" to code,
            "redirect_uri" to REDIRECT_URI,
            "client_id" to clientId,
            "code_verifier" to verifier,
        )
        saveTokens(json)
        prefs.spotifyVerifier = null
        prefs.spotifyState = null
        val me = JSONObject(api("GET", "/me").second)
        val name = me.optString("display_name").ifEmpty { me.optString("id") }
        prefs.spotifyUser = name
        name
    }

    fun disconnect() = prefs.clearSpotify()

    // ---------- play ----------

    fun playRandomFavorite(onResult: (PlayResult) -> Unit) {
        io.execute {
            val result = try {
                val track = randomFavorite()
                play(track)
            } catch (e: SpotifyException) {
                when (e.code) {
                    401 -> { prefs.clearSpotify(); PlayResult.Failed("Spotify signed me out. Reconnect in the Yoda app.") }
                    429 -> PlayResult.Failed("Spotify says slow down — try again in a minute.")
                    else -> PlayResult.Failed("Spotify error (${e.code}).")
                }
            } catch (e: Exception) {
                PlayResult.Failed(e.message ?: "Couldn't reach Spotify.")
            }
            onResult(result)
        }
    }

    private fun randomFavorite(): Track {
        val first = JSONObject(api("GET", "/me/tracks?limit=1").second)
        val total = first.optInt("total", 0)
        if (total > 0) {
            val offset = (0 until total).random()
            val page = JSONObject(api("GET", "/me/tracks?limit=1&offset=$offset").second)
            val item = page.optJSONArray("items")?.optJSONObject(0)?.optJSONObject("track")
            if (item != null) return track(item)
        }
        val top = JSONObject(api("GET", "/me/top/tracks?limit=50&time_range=medium_term").second)
        val items = top.optJSONArray("items") ?: JSONArray()
        if (items.length() == 0) throw Exception("You have no Liked Songs yet — heart a few in Spotify!")
        return track(items.getJSONObject((0 until items.length()).random()))
    }

    private fun track(o: JSONObject): Track {
        val artists = o.optJSONArray("artists")
        val names = (0 until (artists?.length() ?: 0)).joinToString(", ") { artists!!.getJSONObject(it).optString("name") }
        return Track(o.getString("uri"), o.optString("name"), names)
    }

    private fun play(track: Track): PlayResult {
        var device = pickDevice()
        var opened = false
        if (device == null) {
            // Nothing is ready to play: wake Spotify on this phone, then wait for it to register.
            openInSpotify(track)
            opened = true
            for (i in 0 until 6) {
                Thread.sleep(1500)
                device = pickDevice()
                if (device != null) break
            }
            if (device == null) return PlayResult.Opened(track)
        }
        val body = JSONObject().put("uris", JSONArray().put(track.uri)).toString()
        val (code, _) = api("PUT", "/me/player/play?device_id=${enc(device)}", body, allowError = true)
        return when (code) {
            200, 202, 204 -> PlayResult.Playing(track)
            403 -> { // Spotify Free can't be remote-controlled
                if (!opened) openInSpotify(track)
                PlayResult.Opened(track)
            }
            401 -> throw SpotifyException(401, "unauthorized")
            else -> {
                if (!opened) openInSpotify(track)
                PlayResult.Opened(track)
            }
        }
    }

    /** Active device first, then this phone, then anything that's around. */
    private fun pickDevice(): String? {
        val json = JSONObject(api("GET", "/me/player/devices").second)
        val arr = json.optJSONArray("devices") ?: return null
        val devices = (0 until arr.length()).map { arr.getJSONObject(it) }.filter { !it.optBoolean("is_restricted") }
        val chosen = devices.firstOrNull { it.optBoolean("is_active") }
            ?: devices.firstOrNull { it.optString("type").equals("Smartphone", true) }
            ?: devices.firstOrNull()
        return chosen?.optString("id")?.takeIf { it.isNotEmpty() }
    }

    private fun openInSpotify(track: Track) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(track.uri))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            ctx.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            val id = track.uri.substringAfterLast(':')
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://open.spotify.com/track/$id")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    // ---------- HTTP ----------

    private fun accessToken(): String {
        val access = prefs.spotifyAccess
        if (access != null && System.currentTimeMillis() < prefs.spotifyExpiresAt - 60_000) return access
        val refresh = prefs.spotifyRefresh ?: throw Exception("Connect Spotify in the Yoda app first.")
        val json = tokenRequest("grant_type" to "refresh_token", "refresh_token" to refresh, "client_id" to clientId)
        saveTokens(json)
        return prefs.spotifyAccess!!
    }

    private fun saveTokens(json: JSONObject) {
        prefs.spotifyAccess = json.getString("access_token")
        prefs.spotifyExpiresAt = System.currentTimeMillis() + json.optLong("expires_in", 3600) * 1000
        json.optString("refresh_token").takeIf { it.isNotEmpty() }?.let { prefs.spotifyRefresh = it }
    }

    private fun tokenRequest(vararg form: Pair<String, String>): JSONObject {
        val body = form.joinToString("&") { "${enc(it.first)}=${enc(it.second)}" }
        val (code, text) = http("POST", "https://accounts.spotify.com/api/token", body, "application/x-www-form-urlencoded", null)
        if (code !in 200..299) {
            if (code == 400 && text.contains("invalid_grant")) prefs.clearSpotify()
            throw SpotifyException(code, "Spotify sign-in failed ($code)")
        }
        return JSONObject(text)
    }

    private fun api(method: String, path: String, body: String? = null, allowError: Boolean = false): Pair<Int, String> {
        val res = http(method, API + path, body, if (body != null) "application/json" else null, accessToken())
        if (!allowError && res.first !in 200..299) throw SpotifyException(res.first, res.second)
        return res
    }

    private fun http(method: String, url: String, body: String?, contentType: String?, bearer: String?): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            bearer?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
            if (body != null || method == "PUT" || method == "POST") {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", contentType ?: "application/json")
                conn.outputStream.use { it.write((body ?: "").toByteArray()) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally {
            conn.disconnect()
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
