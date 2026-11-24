package com.listeningmirror.companion.logic

enum class Provenance {
    SPOTIFY_METADATA,
    YOUTUBE_TITLE_PARSE,
    YOUTUBE_TOPIC_CHANNEL,
    YOUTUBE_UPLOADER,
    METADATA_ENRICHMENT,
    UNRESOLVED,
}

/**
 * Internal normalized metadata with provenance. The public
 * CurrentListeningState contract stays unchanged.
 *
 * artistCandidate retains a plausible title-derived artist even when a future
 * resolver decides not to promote it. uploaderCandidate preserves YouTube's
 * raw METADATA_KEY_ARTIST separately so channel/uploader identity is never
 * accidentally conflated with musical artist identity.
 */
data class ResolvedMetadata(
    val artist: String?,
    val track: String?,
    val album: String?,
    val artistProvenance: Provenance,
    val artistIsCanonical: Boolean,
    val artistCandidate: String? = artist,
    val uploaderCandidate: String? = null,
) {
    companion object {
        fun unresolvedArtist(
            track: String?,
            album: String?,
            provenance: Provenance = Provenance.UNRESOLVED,
            artistCandidate: String? = null,
            uploaderCandidate: String? = null,
        ) = ResolvedMetadata(
            artist = null,
            track = track,
            album = album,
            artistProvenance = provenance,
            artistIsCanonical = false,
            artistCandidate = artistCandidate,
            uploaderCandidate = uploaderCandidate,
        )
    }
}
