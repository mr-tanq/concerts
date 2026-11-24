package com.listeningmirror.companion.logic

import com.listeningmirror.companion.model.CurrentListeningState
import com.listeningmirror.companion.model.RawPlaybackState
import com.listeningmirror.companion.model.RawSessionSnapshot

/**
 * Turns the SELECTED RawSessionSnapshot into a CurrentListeningState. Pure
 * function of its inputs -- everything beyond simple field copying is
 * delegated to the other logic/ objects, so this stays a thin wiring layer
 * rather than re-implementing any of their rules.
 */
object StateNormalizer {
    /**
     * @param elapsedRealtimeNowMs SystemClock.elapsedRealtime() captured at
     *        the SAME moment as capturedAtIso. Both describe one instant --
     *        that's precisely what makes the resulting positionMs mean
     *        "position as of capturedAt" rather than "position as of
     *        whenever Android last happened to update its anchor".
     */
    fun normalize(
        snapshot: RawSessionSnapshot,
        capturedAtIso: String,
        elapsedRealtimeNowMs: Long,
    ): CurrentListeningState {
        val source = SourceMapper.sourceFor(snapshot.packageName)

        // Spotify's metadata is canonical and is never re-derived. YouTube's
        // goes through the resolver, because its "artist" field is often the
        // uploader/channel rather than the musical artist.
        val resolved = if (source == SourceMapper.SOURCE_YOUTUBE || source == SourceMapper.SOURCE_YOUTUBE_MUSIC) {
            YouTubeMetadataResolver.resolve(snapshot.artist, snapshot.track, snapshot.album)
        } else {
            ResolvedMetadata(
                artist = snapshot.artist,
                track = TitleNormalizer.normalizeTrack(source, snapshot.track, snapshot.artist),
                album = snapshot.album,
                artistProvenance = if (source == SourceMapper.SOURCE_SPOTIFY) Provenance.SPOTIFY_METADATA
                                   else Provenance.UNRESOLVED,
                artistIsCanonical = source == SourceMapper.SOURCE_SPOTIFY,
            )
        }

        val artwork = ArtworkResolver.resolve(
            source = source,
            artworkUri = snapshot.albumArtUri ?: snapshot.artUri,
            mediaUri = snapshot.mediaUri,
            hasBitmap = snapshot.hasAlbumArtBitmap || snapshot.hasArtBitmap,
        )

        return CurrentListeningState(
            source = source,
            // Null rather than a low-confidence uploader: a wrong artist
            // breaks lyrics, identity, artwork lookup and future history at
            // once, so unresolved is strictly better than confidently wrong.
            artist = resolved.artist,
            primaryArtist = resolved.artist,
            track = resolved.track,
            album = resolved.album,
            artwork = artwork.url,
            isPlaying = snapshot.playbackState == RawPlaybackState.PLAYING,
            durationMs = DurationNormalizer.normalize(snapshot.durationMsRaw),
            positionMs = PositionNormalizer.normalizedNow(
                positionRaw = snapshot.positionRaw,
                lastPositionUpdateTimeMs = snapshot.lastPositionUpdateTimeMs,
                state = snapshot.playbackState,
                elapsedRealtimeNowMs = elapsedRealtimeNowMs,
            ),
            externalId = snapshot.mediaId,
            externalUrl = snapshot.mediaUri,
            confidence = null,
            capturedAt = capturedAtIso,
            controlsSupported = false,
        )
    }
}
