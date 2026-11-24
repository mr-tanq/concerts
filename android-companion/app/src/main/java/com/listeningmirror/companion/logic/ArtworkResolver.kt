package com.listeningmirror.companion.logic

/**
 * Where a piece of artwork came from. Kept distinct because a VIDEO
 * THUMBNAIL is an acceptable visual fallback but is NOT canonical album art
 * -- and future enrichment / ambient recognition must be able to replace it
 * without Mirror's rendering changing again.
 */
enum class ArtworkKind {
    /** A browser-safe URL the source itself provided. */
    SOURCE_URI,
    /** A YouTube video thumbnail derived from a VERIFIED video ID. */
    VIDEO_THUMBNAIL,
    /** Reserved: canonical album art from enrichment / recognition. */
    CANONICAL_ALBUM_ART,
    /** Nothing usable. */
    NONE,
}

data class ResolvedArtwork(val url: String?, val kind: ArtworkKind)

/**
 * Resolution order (C1):
 *   1. an existing browser-safe http/https artwork URI
 *   2. a YouTube thumbnail, but ONLY from a genuinely verified video ID
 *   3. bitmap fallback -- NOT implemented, see the note below
 *
 * A video ID is only ever taken from something that is unambiguously a
 * YouTube URL. A bare media ID is never treated as one: YouTube IDs are
 * 11 chars of [A-Za-z0-9_-], a shape countless unrelated IDs also match, so
 * "looks like an ID" is not verification and would produce confidently
 * broken image URLs.
 *
 * BITMAP FALLBACK IS DELIBERATELY NOT IMPLEMENTED. It cannot be done
 * securely with the current backend: the relay's only write surface is
 * publish_playback, and base64 inside CurrentListeningState is explicitly
 * forbidden (it would also be resent on every 20s heartbeat). Doing it
 * properly needs a new authenticated storage path -- see the delivery notes.
 * The interface below is shaped so that path slots in without callers
 * changing.
 */
object ArtworkResolver {

    private val YOUTUBE_URL_PATTERNS = listOf(
        Regex("""https?://(?:www\.|m\.|music\.)?youtube\.com/watch\?(?:[^&]*&)*v=([A-Za-z0-9_-]{11})(?:[&#].*)?$""", RegexOption.IGNORE_CASE),
        Regex("""https?://youtu\.be/([A-Za-z0-9_-]{11})(?:[?#].*)?$""", RegexOption.IGNORE_CASE),
        Regex("""https?://(?:www\.|m\.)?youtube\.com/(?:embed|shorts|live)/([A-Za-z0-9_-]{11})(?:[?#].*)?$""", RegexOption.IGNORE_CASE),
    )

    /**
     * A video ID, only when the input is genuinely a YouTube URL. Returns
     * null for a bare ID-shaped string -- that is not verification.
     */
    fun verifiedYouTubeVideoId(mediaUri: String?): String? {
        val uri = mediaUri?.trim() ?: return null
        for (pattern in YOUTUBE_URL_PATTERNS) {
            val m = pattern.find(uri)
            if (m != null) return m.groupValues[1]
        }
        return null
    }

    fun resolve(
        source: String,
        artworkUri: String?,
        mediaUri: String?,
        hasBitmap: Boolean,
    ): ResolvedArtwork {
        // 1. Whatever the source gave us, if a browser can actually load it.
        val safe = com.listeningmirror.companion.transport.ArtworkPolicy.browserSafeArtwork(artworkUri)
        if (safe != null) return ResolvedArtwork(safe, ArtworkKind.SOURCE_URI)

        // 2. YouTube thumbnail from a verified video ID.
        if (source == SourceMapper.SOURCE_YOUTUBE || source == SourceMapper.SOURCE_YOUTUBE_MUSIC) {
            val videoId = verifiedYouTubeVideoId(mediaUri)
            if (videoId != null) {
                return ResolvedArtwork(
                    "https://i.ytimg.com/vi/$videoId/hqdefault.jpg",
                    ArtworkKind.VIDEO_THUMBNAIL
                )
            }
        }

        // 3. Bitmap fallback would go here. Intentionally not implemented --
        // hasBitmap is accepted so callers/diagnostics can SEE that a bitmap
        // existed and was declined, rather than the case vanishing silently.
        return ResolvedArtwork(null, ArtworkKind.NONE)
    }
}
