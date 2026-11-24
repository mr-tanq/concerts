package com.listeningmirror.companion.logic

import com.listeningmirror.companion.model.RawPlaybackState
import com.listeningmirror.companion.model.RawSessionSnapshot

/**
 * Deterministic, pure selection logic -- takes the current raw session
 * list plus whichever SESSION was selected last time, returns the
 * sessionId that should be selected now (or null for "no active device
 * playback").
 *
 * Operates on sessionId, never on packageName: the thing being selected is
 * one specific MediaSession, and an app publishing two sessions must not
 * have them collapse into a single selectable identity.
 *
 * Rules, in order:
 *   1. Any session genuinely PLAYING beats everything else. Among
 *      multiple genuinely-playing sessions (rare -- Android's audio focus
 *      system generally prevents two apps producing audible audio at
 *      once), Android's own getActiveSessions() priority order breaks the
 *      tie -- never "whichever happened to be first in the list".
 *   2. If nothing is genuinely playing, but the PREVIOUSLY selected
 *      session is still present and merely TRANSITIONAL (buffering,
 *      connecting, seeking, skipping), stay on it rather than falling
 *      through to a stale paused session or to "nothing". This is a
 *      STATE-based stickiness check, not a time-based one -- no invented
 *      timeout values; the prototype exposes raw state so real timing
 *      behavior can be observed on-device first.
 *   3. Otherwise, no active device playback right now.
 */
object ActiveSessionSelector {

    fun select(sessions: List<RawSessionSnapshot>, previouslySelectedSessionId: String?): String? {
        if (sessions.isEmpty()) return null

        val playing = sessions.filter { it.playbackState == RawPlaybackState.PLAYING }
        if (playing.isNotEmpty()) {
            return playing.minByOrNull { it.osPriorityIndex }!!.sessionId
        }

        if (previouslySelectedSessionId != null) {
            val stillThere = sessions.find { it.sessionId == previouslySelectedSessionId }
            if (stillThere != null && stillThere.playbackState == RawPlaybackState.TRANSITIONAL) {
                return previouslySelectedSessionId
            }
        }

        return null
    }
}
