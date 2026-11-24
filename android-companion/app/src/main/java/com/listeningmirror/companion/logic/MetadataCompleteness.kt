package com.listeningmirror.companion.logic

/**
 * Whether the artist+track pair is meaningful enough for the existing
 * lyrics lookup (getSyncedLyrics() on the web side needs both). This is
 * deliberately a separate, boolean signal from `confidence` — metadata
 * completeness ("do we have the two strings the lyrics lookup needs") and
 * recognition confidence ("how much do we trust this source's claim about
 * what's playing") are different concepts, and collapsing them into one
 * invented number was explicitly the thing the master's review corrected.
 *
 * Deliberately no attempt at parsing a bare title like
 * "ARTIST - SONG [Official Video]" into a fake artist/track split — per
 * the master's explicit instruction, this phase shows what Android
 * actually gives us, not a guess dressed up as structured data.
 */
object MetadataCompleteness {
    fun isCompleteForLyrics(artist: String?, track: String?): Boolean {
        return !artist.isNullOrBlank() && !track.isNullOrBlank()
    }
}
