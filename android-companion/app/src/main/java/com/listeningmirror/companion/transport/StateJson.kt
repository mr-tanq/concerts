package com.listeningmirror.companion.transport

import com.listeningmirror.companion.model.CurrentListeningState
import org.json.JSONObject

/**
 * CurrentListeningState -> JSON for the relay. Hand-rolled with org.json
 * (in the Android platform, zero dependencies) rather than pulling in a
 * serialization library for one flat object.
 *
 * Only the generic contract crosses the wire. The raw diagnostic snapshot
 * stays local to the debug screen, per scope.
 */
object StateJson {

    /**
     * Delegates to ArtworkPolicy, which is kept in its own Android-free file
     * so the verifier can test the real rule rather than a copy.
     */
    fun browserSafeArtwork(artwork: String?): String? = ArtworkPolicy.browserSafeArtwork(artwork)

    fun toJson(state: CurrentListeningState): JSONObject {
        val o = JSONObject()
        // put(key, null) removes the key in org.json, so use JSONObject.NULL
        // explicitly -- an absent field and an explicitly-null field must not
        // be conflated on the wire.
        fun putOrNull(key: String, value: Any?) {
            o.put(key, value ?: JSONObject.NULL)
        }
        putOrNull("source", state.source)
        putOrNull("artist", state.artist)
        putOrNull("primaryArtist", state.primaryArtist)
        putOrNull("track", state.track)
        putOrNull("album", state.album)
        putOrNull("artwork", browserSafeArtwork(state.artwork))
        o.put("isPlaying", state.isPlaying)
        putOrNull("durationMs", state.durationMs)
        putOrNull("positionMs", state.positionMs)
        putOrNull("externalId", state.externalId)
        putOrNull("externalUrl", state.externalUrl)
        putOrNull("confidence", state.confidence)
        putOrNull("capturedAt", state.capturedAt)
        o.put("controlsSupported", state.controlsSupported)
        return o
    }
}
