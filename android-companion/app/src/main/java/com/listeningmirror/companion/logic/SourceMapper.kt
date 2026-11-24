package com.listeningmirror.companion.logic

/**
 * Package name -> source string. Deliberately a closed, tiny list per the
 * investigation's explicit MVP scope (Spotify first, YouTube second) —
 * this is not meant to grow into a general media-app registry. Anything
 * unrecognized normalizes to "android_media" rather than being dropped or
 * crashing, so the debug screen can still show *something* is playing
 * even for an app we haven't named.
 */
object SourceMapper {
    const val PACKAGE_SPOTIFY = "com.spotify.music"
    const val PACKAGE_YOUTUBE = "com.google.android.youtube"
    const val PACKAGE_YOUTUBE_MUSIC = "com.google.android.apps.youtube.music"

    const val SOURCE_SPOTIFY = "spotify_android"
    const val SOURCE_YOUTUBE = "youtube_android"
    const val SOURCE_YOUTUBE_MUSIC = "youtube_music_android"
    const val SOURCE_UNKNOWN = "android_media"

    fun sourceFor(packageName: String): String = when (packageName) {
        PACKAGE_SPOTIFY -> SOURCE_SPOTIFY
        PACKAGE_YOUTUBE -> SOURCE_YOUTUBE
        PACKAGE_YOUTUBE_MUSIC -> SOURCE_YOUTUBE_MUSIC
        else -> SOURCE_UNKNOWN
    }
}
