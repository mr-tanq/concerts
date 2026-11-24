package com.listeningmirror.companion.model

/**
 * The Android-side equivalent of the generic CurrentListeningState contract
 * that spotify-listening-provider.js already establishes on the web side.
 * Deliberately not expanded with a playbackSpeed field — per explicit
 * correction #2, variable playback rate is out of scope for this MVP, and
 * Mirror's interpolation clock is not being touched.
 *
 * A field is null whenever this source legitimately can't provide it, or
 * (for positionMs specifically) whenever what Android reported isn't
 * trustworthy enough to treat as a real anchor — never a placeholder or
 * invented value. See PositionNormalizer and DurationNormalizer for the
 * exact rules.
 */
data class CurrentListeningState(
    val source: String,
    val artist: String?,
    // Android's MediaSession gives one artist string, not a list the way
    // Spotify's Web API does — there is nothing to split, so this is
    // always identical to `artist` for every Android-sourced state. Kept
    // as its own field only for shape-parity with the existing contract.
    val primaryArtist: String?,
    val track: String?,
    val album: String?,
    val artwork: String?,
    val isPlaying: Boolean,
    val durationMs: Long?,
    val positionMs: Long?,
    val externalId: String?,
    val externalUrl: String?,
    // Deliberately null in this phase — per explicit correction, metadata
    // completeness and recognition confidence are different concepts, and
    // inventing a number like 0.9 or 0.5 without a defined meaning behind
    // it would be exactly the kind of guessed value this whole contract
    // exists to avoid. See MetadataCompleteness for the separate,
    // explicit "do we have enough for lyrics" signal instead.
    val confidence: Double?,
    val capturedAt: String,
    val controlsSupported: Boolean,
)
