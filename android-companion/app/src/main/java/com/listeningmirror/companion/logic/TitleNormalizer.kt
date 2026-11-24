package com.listeningmirror.companion.logic

/**
 * Conservative, YouTube-only cleanup of the MediaSession title.
 *
 * Ordinary YouTube reports (confirmed on a real Samsung S23):
 *     ARTIST: Judas Priest
 *     TITLE:  Judas Priest - The Sentinel (Official Audio)
 * where the artist field is already correct and separate. So this file's
 * only job is removing the redundant artist prefix and a small closed set
 * of presentation suffixes, leaving "The Sentinel".
 *
 * Deliberately NOT a heuristic title parser:
 *   - the artist is never inferred from the title; it's only ever removed
 *     when MediaSession already told us the artist independently
 *   - arbitrary parenthetical text is never stripped, only the exact
 *     known suffixes in KNOWN_SUFFIXES
 *   - titles are never split on hyphens generally; a hyphen only matters
 *     when it directly follows a full, exact artist prefix
 *   - anything that would leave an empty track is abandoned entirely
 *
 * Applies to youtube_android only. Spotify's titles are already clean and
 * must pass through untouched.
 */
object TitleNormalizer {

    /**
     * Separators seen between artist and title on YouTube. Plain hyphen,
     * en dash, and em dash — the three the review called out.
     */
    private val SEPARATORS = listOf("-", "\u2013", "\u2014")

    /**
     * A closed, explicit list. Matching is case-insensitive and anchored to
     * the END of the title. Both bracket styles are listed separately
     * rather than pattern-matched, so nothing outside this list can ever
     * be removed by accident.
     */
    private val KNOWN_SUFFIXES = listOf(
        "(Official Audio)", "[Official Audio]",
        "(Official Video)", "[Official Video]",
        "(Official Music Video)", "[Official Music Video]",
        "(Lyric Video)", "[Lyric Video]",
        "(Official Lyric Video)", "[Official Lyric Video]",
    )

    /** True only for the same closed, END-anchored suffix list we strip. */
    fun hasKnownPresentationSuffix(rawTitle: String?): Boolean {
        val title = rawTitle?.trim() ?: return false
        return KNOWN_SUFFIXES.any { suffix ->
            title.length > suffix.length && title.endsWith(suffix, ignoreCase = true)
        }
    }

    /**
     * @param source the normalized source string (see SourceMapper)
     * @param rawTitle the untouched MediaSession title
     * @param artist the MediaSession artist, used ONLY for exact prefix
     *        removal — never as a source of inference
     * @return the cleaned track, or rawTitle unchanged when this doesn't
     *         confidently apply
     */
    fun normalizeTrack(source: String, rawTitle: String?, artist: String?): String? {
        if (rawTitle == null) return null
        if (source != SourceMapper.SOURCE_YOUTUBE) return rawTitle

        var result = rawTitle.trim()
        result = stripArtistPrefix(result, artist)
        result = stripKnownSuffixes(result)

        // Never turn a real title into nothing. If the cleanup consumed
        // everything, the original is strictly more useful than an empty
        // string, so fall back rather than "succeeding" into a blank.
        val cleaned = result.trim()
        return if (cleaned.isEmpty()) rawTitle else cleaned
    }

    /**
     * Removes "<artist><separator>" only when the title genuinely begins
     * with the complete artist string AND a separator follows it.
     *
     * The separator requirement is what makes this safe: for artist
     * "Judas Priest" and title "Judas Priestess - Something", the raw
     * prefix matches, but the next character is "e" rather than a
     * separator, so nothing is removed. A merely-resembling prefix can
     * never be stripped.
     *
     * Comparison is case-sensitive, matching the review's wording of an
     * "exact leading artist prefix".
     */
    private fun stripArtistPrefix(title: String, artist: String?): String {
        if (artist.isNullOrBlank()) return title
        val trimmedArtist = artist.trim()
        if (!title.startsWith(trimmedArtist)) return title

        val remainder = title.substring(trimmedArtist.length).trimStart()
        for (separator in SEPARATORS) {
            if (remainder.startsWith(separator)) {
                val afterSeparator = remainder.substring(separator.length).trimStart()
                // Only accept if something actually remains — "Artist -"
                // alone should stay as-is rather than collapse to nothing.
                if (afterSeparator.isNotEmpty()) return afterSeparator
                return title
            }
        }
        return title
    }

    /**
     * Repeatedly removes trailing known suffixes. Looping handles the
     * (uncommon but real) "Song (Official Video) (Lyric Video)" case
     * without loosening what may be removed — every iteration still only
     * matches the closed list.
     */
    private fun stripKnownSuffixes(title: String): String {
        var result = title.trim()
        var changed = true
        while (changed) {
            changed = false
            for (suffix in KNOWN_SUFFIXES) {
                if (result.length > suffix.length && result.endsWith(suffix, ignoreCase = true)) {
                    result = result.substring(0, result.length - suffix.length).trim()
                    changed = true
                    break
                }
            }
        }
        return result
    }
}
