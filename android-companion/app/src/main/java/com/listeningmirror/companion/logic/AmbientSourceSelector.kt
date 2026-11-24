package com.listeningmirror.companion.logic

import com.listeningmirror.companion.model.CurrentListeningState

/**
 * Android-local source priority for the single relay row.
 * Active device MediaSession playback wins. Ambient wins over a merely
 * paused/stopped device session, otherwise the paused device state remains.
 */
object AmbientSourceSelector {
    fun choose(
        media: CurrentListeningState?,
        ambient: CurrentListeningState?,
    ): CurrentListeningState? = when {
        media?.isPlaying == true -> media
        ambient != null -> ambient
        else -> media
    }
}
