package com.listeningmirror.companion.logic

/**
 * Conservative resolution of ordinary YouTube MediaSession metadata.
 *
 * METADATA_KEY_ARTIST is frequently the uploader/channel, not the musical
 * artist. We therefore preserve it as uploader provenance and promote an
 * artist only when the title/channel provides explicit corroboration.
 */
object YouTubeMetadataResolver {

    private const val TOPIC_SUFFIX = " - Topic"
    private val SPACED_SEPARATOR = Regex("\\s+[-\\u2013\\u2014]\\s+")

    private fun normalize(s: String?) =
        (s ?: "").lowercase().replace(Regex("\\s+"), " ").trim()

    fun resolve(uploader: String?, rawTitle: String?, album: String?): ResolvedMetadata {
        val cleanedWithUploader = TitleNormalizer.normalizeTrack(
            SourceMapper.SOURCE_YOUTUBE, rawTitle, uploader
        )
        val uploaderTrimmed = uploader?.trim()?.takeIf { it.isNotEmpty() }

        if (rawTitle.isNullOrBlank()) {
            return ResolvedMetadata.unresolvedArtist(
                cleanedWithUploader,
                album,
                if (uploaderTrimmed == null) Provenance.UNRESOLVED else Provenance.YOUTUBE_UPLOADER,
                uploaderCandidate = uploaderTrimmed,
            )
        }

        // Tier 1: YouTube's auto-generated <Artist> - Topic channel.
        if (uploaderTrimmed != null && uploaderTrimmed.endsWith(TOPIC_SUFFIX, ignoreCase = true)) {
            val artist = uploaderTrimmed.dropLast(TOPIC_SUFFIX.length).trim()
            if (plausibleArtist(artist)) {
                return canonical(
                    artist = artist,
                    rawTitle = rawTitle,
                    album = album,
                    provenance = Provenance.YOUTUBE_TOPIC_CHANNEL,
                    uploader = uploaderTrimmed,
                )
            }
        }

        val title = rawTitle.trim()

        // Tier 2: the title explicitly begins with the complete uploader plus
        // one supported separator. This avoids the old mixed-separator bug by
        // checking the prefix directly instead of asking which separator TYPE
        // happens to be searched first.
        if (uploaderTrimmed != null && titleBeginsWithArtist(title, uploaderTrimmed)) {
            return canonical(
                artist = uploaderTrimmed,
                rawTitle = rawTitle,
                album = album,
                provenance = Provenance.YOUTUBE_TITLE_PARSE,
                uploader = uploaderTrimmed,
            )
        }

        val split = splitOnSingleEarliestSeparator(title)
        if (split != null) {
            val (lead, remainder) = split

            // Tier 3: standard published music-video convention. The marker
            // must be one of TitleNormalizer's KNOWN TRAILING suffixes; words
            // such as "official video" in the middle of a reaction title are
            // not evidence.
            if (TitleNormalizer.hasKnownPresentationSuffix(title) &&
                plausibleArtist(lead) && plausibleTrack(remainder)) {
                return canonical(
                    artist = lead,
                    rawTitle = rawTitle,
                    album = album,
                    provenance = Provenance.YOUTUBE_TITLE_PARSE,
                    uploader = uploaderTrimmed,
                )
            }

            // Tier 4: narrow exact "Artist - Track" form without an official
            // suffix. This covers real uploads such as:
            //   uploader Radio Nova
            //   title    Ezechiel Pailhes - Éternel été | Live Plus Près De Toi
            // while explicit descriptor guards reject shapes such as
            // "Live 1982 - Full Concert" and
            // "My reaction to official video - Gorillaz".
            if (plausibleArtist(lead) && plausibleTrack(remainder) &&
                !looksLikePresentationDescriptor(lead)) {
                return canonical(
                    artist = lead,
                    rawTitle = rawTitle,
                    album = album,
                    provenance = Provenance.YOUTUBE_TITLE_PARSE,
                    uploader = uploaderTrimmed,
                )
            }

            // Preserve the plausible leading segment diagnostically even when
            // it was not safe enough to publish as canonical.
            val candidate = lead.takeIf { plausibleArtist(it) && !looksLikePresentationDescriptor(it) }
            return ResolvedMetadata.unresolvedArtist(
                track = cleanedWithUploader,
                album = album,
                provenance = if (uploaderTrimmed == null) Provenance.UNRESOLVED else Provenance.YOUTUBE_UPLOADER,
                artistCandidate = candidate,
                uploaderCandidate = uploaderTrimmed,
            )
        }

        return ResolvedMetadata.unresolvedArtist(
            cleanedWithUploader,
            album,
            if (uploaderTrimmed == null) Provenance.UNRESOLVED else Provenance.YOUTUBE_UPLOADER,
            uploaderCandidate = uploaderTrimmed,
        )
    }

    private fun canonical(
        artist: String,
        rawTitle: String,
        album: String?,
        provenance: Provenance,
        uploader: String?,
    ): ResolvedMetadata = ResolvedMetadata(
        artist = artist,
        track = TitleNormalizer.normalizeTrack(SourceMapper.SOURCE_YOUTUBE, rawTitle, artist),
        album = album,
        artistProvenance = provenance,
        artistIsCanonical = true,
        artistCandidate = artist,
        uploaderCandidate = uploader,
    )

    private fun titleBeginsWithArtist(title: String, artist: String): Boolean {
        if (title.length <= artist.length) return false
        if (!title.regionMatches(0, artist, 0, artist.length, ignoreCase = true)) return false
        val remainder = title.substring(artist.length)
        return Regex("^\\s*[-\\u2013\\u2014]\\s*\\S+").containsMatchIn(remainder)
    }

    /** Choose the earliest actual separator occurrence, regardless of dash type. */
    private fun splitOnSingleEarliestSeparator(title: String): Pair<String, String>? {
        val matches = SPACED_SEPARATOR.findAll(title).toList()
        if (matches.size != 1) return null
        val m = matches.single()
        val lead = title.substring(0, m.range.first).trim()
        val remainder = title.substring(m.range.last + 1).trim()
        if (lead.isEmpty() || remainder.isEmpty()) return null
        return lead to remainder
    }

    private fun plausibleArtist(candidate: String): Boolean {
        val c = candidate.trim()
        if (c.isEmpty() || c.length > 60) return false
        if (c.contains("|") || c.contains('"')) return false
        if (c.none { it.isLetter() }) return false
        if (Regex("^(19|20)\\d{2}(?:\\b|\\s)").containsMatchIn(c)) return false
        return true
    }

    private fun plausibleTrack(candidate: String): Boolean {
        val c = candidate.trim()
        if (c.isEmpty() || c.none { it.isLetter() }) return false
        val n = normalize(c)
        if (n == "full concert" || n == "full album" || n == "playlist") return false
        return true
    }

    /**
     * Left-hand descriptions that are demonstrably not performer names in the
     * exact Artist - Track convention. Kept deliberately narrow: no broad
     * "contains album/live" rule that could reject legitimate artist names.
     */
    private fun looksLikePresentationDescriptor(candidate: String): Boolean {
        val n = normalize(candidate)
        if (Regex("^(19|20)\\d{2}\\b").containsMatchIn(n)) return true
        val prefixes = listOf(
            "live ",
            "full ",
            "official ",
            "my reaction",
            "reaction ",
            "reacting ",
            "review ",
            "remaster ",
            "best of ",
            "playlist ",
        )
        if (prefixes.any { n.startsWith(it) }) return true
        if (n.contains("official video") || n.contains("official audio")) return true
        return false
    }
}
