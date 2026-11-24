package com.listeningmirror.companion.transport

/**
 * Which artwork values may cross the wire to a browser.
 *
 * Its own file, with zero Android imports, deliberately: StateJson needs
 * android's org.json and therefore cannot be compiled or tested off-device,
 * but this rule is the part that actually needs testing. Keeping it separate
 * means the verifier exercises the REAL implementation rather than a copy of
 * it that could silently drift.
 *
 * Real-device findings this encodes: Spotify Android exposes content:// URIs
 * and ordinary YouTube exposes only a Bitmap with no URI at all. Neither is
 * loadable from a web page, and transporting one would put a permanently
 * broken image URL into Mirror. Bitmap transport is out of scope for this
 * slice, so anything not http(s) becomes null.
 */
object ArtworkPolicy {
    fun browserSafeArtwork(artwork: String?): String? {
        if (artwork == null) return null
        val trimmed = artwork.trim()
        val lower = trimmed.lowercase()
        if (lower.startsWith("http://") || lower.startsWith("https://")) return trimmed
        return null
    }
}
