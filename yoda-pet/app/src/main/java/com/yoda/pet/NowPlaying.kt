package com.yoda.pet

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaMetadata
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState

/** What's playing on this phone right now, from any music app (Spotify, YouTube Music, …). */
object NowPlaying {

    data class Song(val title: String, val artist: String?, val app: String?, val playing: Boolean)

    /**
     * Reads the phone's active media sessions. Needs the notification access
     * Yoda already has for Gmail; returns null without it or when nothing is loaded.
     */
    fun onThisPhone(ctx: Context): Song? {
        val msm = ctx.getSystemService(MediaSessionManager::class.java) ?: return null
        val controllers = try {
            msm.getActiveSessions(ComponentName(ctx, GmailListener::class.java))
        } catch (_: SecurityException) {
            return null
        }
        val withSong = controllers.filter { !it.metadata?.getString(MediaMetadata.METADATA_KEY_TITLE).isNullOrBlank() }
        val c = withSong.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: withSong.firstOrNull() ?: return null
        val m = c.metadata!!
        val artist = m.getString(MediaMetadata.METADATA_KEY_ARTIST)
            ?: m.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
        return Song(
            title = m.getString(MediaMetadata.METADATA_KEY_TITLE),
            artist = artist?.takeIf { it.isNotBlank() },
            app = appName(ctx, c.packageName),
            playing = c.playbackState?.state == PlaybackState.STATE_PLAYING,
        )
    }

    private fun appName(ctx: Context, pkg: String): String? = try {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: PackageManager.NameNotFoundException) {
        null
    }
}
