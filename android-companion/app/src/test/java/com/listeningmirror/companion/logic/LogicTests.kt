package com.listeningmirror.companion.logic

import com.listeningmirror.companion.android.KeepaliveLifecycle
import com.listeningmirror.companion.logic.ArtworkKind
import com.listeningmirror.companion.logic.ArtworkResolver
import com.listeningmirror.companion.logic.Provenance
import com.listeningmirror.companion.logic.YouTubeMetadataResolver
import com.listeningmirror.companion.model.CurrentListeningState
import com.listeningmirror.companion.model.RawPlaybackState
import com.listeningmirror.companion.model.RawSessionSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun snapshot(
    packageName: String,
    state: RawPlaybackState,
    sessionId: String = "session-of-$packageName",
    artist: String? = "Artist",
    track: String? = "Track",
    album: String? = null,
    durationMsRaw: Long? = 200_000L,
    positionRaw: Long? = 1_000L,
    lastPositionUpdateTimeMs: Long? = 123_456L,
    osPriorityIndex: Int = 0,
): RawSessionSnapshot = RawSessionSnapshot(
    sessionId = sessionId,
    packageName = packageName,
    playbackState = state,
    rawPlaybackStateInt = null,
    artist = artist,
    track = track,
    album = album,
    mediaId = null,
    mediaUri = null,
    artUri = null,
    albumArtUri = null,
    hasArtBitmap = false,
    hasAlbumArtBitmap = false,
    durationMsRaw = durationMsRaw,
    positionRaw = positionRaw,
    lastPositionUpdateTimeMs = lastPositionUpdateTimeMs,
    playbackSpeed = 1.0f,
    osPriorityIndex = osPriorityIndex,
)

class SourceMapperTest {
    @Test fun spotifyPackageMapsToSpotifyAndroid() {
        assertEquals("spotify_android", SourceMapper.sourceFor("com.spotify.music"))
    }
    @Test fun youtubePackageMapsToYoutubeAndroid() {
        assertEquals("youtube_android", SourceMapper.sourceFor("com.google.android.youtube"))
    }
    @Test fun youtubeMusicPackageMapsCorrectly() {
        assertEquals("youtube_music_android", SourceMapper.sourceFor("com.google.android.apps.youtube.music"))
    }
    @Test fun unknownPackageMapsToAndroidMedia() {
        assertEquals("android_media", SourceMapper.sourceFor("com.example.somerandomapp"))
    }
    @Test fun emptyPackageNameDoesNotCrashAndFallsBackToUnknown() {
        assertEquals("android_media", SourceMapper.sourceFor(""))
    }
}

class PositionNormalizerTest {
    @Test fun validPositionWithValidTimestampIsAccepted() {
        assertEquals(45_000L, PositionNormalizer.validAnchorOrNull(45_000L, 999L))
    }
    @Test fun zeroPositionIsValid() {
        assertEquals(0L, PositionNormalizer.validAnchorOrNull(0L, 999L))
    }
    @Test fun playbackPositionUnknownSentinelIsRejected() {
        assertNull(PositionNormalizer.validAnchorOrNull(-1L, 999L))
    }
    @Test fun anyOtherNegativePositionIsRejected() {
        assertNull(PositionNormalizer.validAnchorOrNull(-500L, 999L))
    }
    @Test fun zeroUpdateTimestampMeansNeverSetAndIsRejected() {
        assertNull(PositionNormalizer.validAnchorOrNull(45_000L, 0L))
    }
    @Test fun nullUpdateTimestampIsRejected() {
        assertNull(PositionNormalizer.validAnchorOrNull(45_000L, null))
    }
    @Test fun nullPositionIsRejected() {
        assertNull(PositionNormalizer.validAnchorOrNull(null, 999L))
    }
    @Test fun validPositionButUnknownSentinelTimestampCombinationStillRejected() {
        // position looks fine on its own, but a zero timestamp means the
        // platform itself never actually set it -- must not be trusted.
        assertNull(PositionNormalizer.validAnchorOrNull(0L, 0L))
    }
}

class DurationNormalizerTest {
    @Test fun validDurationIsAccepted() {
        assertEquals(200_000L, DurationNormalizer.normalize(200_000L))
    }
    @Test fun negativeDurationIsUnknownPerMediaMetadataContract() {
        assertNull(DurationNormalizer.normalize(-1L))
    }
    @Test fun nullDurationIsUnknown() {
        assertNull(DurationNormalizer.normalize(null))
    }
    @Test fun zeroDurationIsAcceptedAsIs() {
        assertEquals(0L, DurationNormalizer.normalize(0L))
    }
}

class MetadataCompletenessTest {
    @Test fun bothPresentIsComplete() {
        assertTrue(MetadataCompleteness.isCompleteForLyrics("Mono", "Ashes in the Snow"))
    }
    @Test fun missingArtistIsIncomplete() {
        assertFalse(MetadataCompleteness.isCompleteForLyrics(null, "Track"))
    }
    @Test fun missingTrackIsIncomplete() {
        assertFalse(MetadataCompleteness.isCompleteForLyrics("Artist", null))
    }
    @Test fun blankStringsAreTreatedAsMissing() {
        assertFalse(MetadataCompleteness.isCompleteForLyrics("   ", "Track"))
        assertFalse(MetadataCompleteness.isCompleteForLyrics("Artist", ""))
    }
    @Test fun bothMissingIsIncomplete() {
        assertFalse(MetadataCompleteness.isCompleteForLyrics(null, null))
    }
}

class ActiveSessionSelectorTest {
    @Test fun emptySessionListSelectsNothing() {
        assertNull(ActiveSessionSelector.select(emptyList(), null))
    }

    @Test fun singlePlayingSessionIsSelected() {
        val sessions = listOf(snapshot("com.spotify.music", RawPlaybackState.PLAYING))
        assertEquals("session-of-com.spotify.music", ActiveSessionSelector.select(sessions, null))
    }

    @Test fun playingBeatsPaused() {
        val sessions = listOf(
            snapshot("com.spotify.music", RawPlaybackState.PAUSED, osPriorityIndex = 0),
            snapshot("com.google.android.youtube", RawPlaybackState.PLAYING, osPriorityIndex = 1),
        )
        assertEquals("session-of-com.google.android.youtube", ActiveSessionSelector.select(sessions, "session-of-com.spotify.music"))
    }

    @Test fun osPriorityOrderBreaksTiesBetweenMultiplePlayingSessions() {
        // Both genuinely playing -- OS priority (lower index) must win,
        // not simply "the first one in whatever order the list happens
        // to be iterated".
        val sessions = listOf(
            snapshot("com.google.android.youtube", RawPlaybackState.PLAYING, osPriorityIndex = 1),
            snapshot("com.spotify.music", RawPlaybackState.PLAYING, osPriorityIndex = 0),
        )
        assertEquals("session-of-com.spotify.music", ActiveSessionSelector.select(sessions, null))
    }

    @Test fun transitionalStateIsStickyIfPreviouslySelected() {
        // Spotify was playing, briefly buffers -- nothing else is
        // genuinely playing -- must NOT fall through to nothing.
        val sessions = listOf(snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL))
        assertEquals("session-of-com.spotify.music", ActiveSessionSelector.select(sessions, "session-of-com.spotify.music"))
    }

    @Test fun transitionalStateDoesNotStickIfItWasNotPreviouslySelected() {
        // A DIFFERENT app is buffering, but was never the selected one --
        // must not adopt it just because it's the only session present.
        val sessions = listOf(snapshot("com.google.android.youtube", RawPlaybackState.TRANSITIONAL))
        assertNull(ActiveSessionSelector.select(sessions, "session-of-com.spotify.music"))
    }

    @Test fun doesNotFlapToStalePausedSessionDuringPreviousSelectionsBuffering() {
        // Exactly the flapping scenario from the master's correction #3:
        // Spotify PLAYING -> Spotify BUFFERING, while a stale PAUSED
        // YouTube session also exists. Must stay on Spotify, not jump to
        // the paused YouTube session.
        val sessions = listOf(
            snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL, osPriorityIndex = 0),
            snapshot("com.google.android.youtube", RawPlaybackState.PAUSED, osPriorityIndex = 1),
        )
        assertEquals("session-of-com.spotify.music", ActiveSessionSelector.select(sessions, "session-of-com.spotify.music"))
    }

    @Test fun previouslySelectedSessionGoneEntirelyMeansNoStickiness() {
        // The previously-selected package isn't in the list at all
        // anymore (app fully closed) -- nothing to stick to.
        val sessions = listOf(snapshot("com.google.android.youtube", RawPlaybackState.PAUSED))
        assertNull(ActiveSessionSelector.select(sessions, "session-of-com.spotify.music"))
    }

    @Test fun allPausedWithNoPreviousSelectionSelectsNothing() {
        val sessions = listOf(
            snapshot("com.spotify.music", RawPlaybackState.PAUSED),
            snapshot("com.google.android.youtube", RawPlaybackState.STOPPED),
        )
        assertNull(ActiveSessionSelector.select(sessions, null))
    }

    @Test fun newlyPlayingSessionOverridesOldTransitionalStickiness() {
        // Spotify was buffering (sticky), but YouTube has genuinely
        // started playing in the meantime -- playing must win outright,
        // stickiness only applies when NOTHING is genuinely playing.
        val sessions = listOf(
            snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL, osPriorityIndex = 0),
            snapshot("com.google.android.youtube", RawPlaybackState.PLAYING, osPriorityIndex = 1),
        )
        assertEquals("session-of-com.google.android.youtube", ActiveSessionSelector.select(sessions, "session-of-com.spotify.music"))
    }
}

class StateNormalizerTest {
    @Test fun normalizesAFullyPopulatedSpotifySnapshot() {
        val snap = snapshot(
            "com.spotify.music", RawPlaybackState.PLAYING,
            artist = "Mono", track = "Ashes in the Snow", album = "Hymn to the Immortal Wind",
            durationMsRaw = 300_000L, positionRaw = 45_000L, lastPositionUpdateTimeMs = 111L,
        )
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        assertEquals("spotify_android", state.source)
        assertEquals("Mono", state.artist)
        assertEquals("Mono", state.primaryArtist)
        assertEquals("Ashes in the Snow", state.track)
        assertEquals(300_000L, state.durationMs)
        assertEquals(45_000L + (200_000L - 111L), state.positionMs)
        assertTrue(state.isPlaying)
        assertFalse(state.controlsSupported)
        assertNull(state.confidence)
    }

    @Test fun missingMetadataNeverCrashesNormalization() {
        val snap = snapshot(
            "com.example.unknownapp", RawPlaybackState.PAUSED,
            artist = null, track = null, album = null,
            durationMsRaw = null, positionRaw = null, lastPositionUpdateTimeMs = null,
        )
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        assertNull(state.artist)
        assertNull(state.track)
        assertNull(state.durationMs)
        assertNull(state.positionMs)
        assertEquals("android_media", state.source)
        assertFalse(state.isPlaying)
    }

    @Test fun unknownPositionSentinelNeverLeaksIntoNormalizedState() {
        val snap = snapshot(
            "com.spotify.music", RawPlaybackState.PLAYING,
            positionRaw = PositionNormalizer.PLAYBACK_POSITION_UNKNOWN, lastPositionUpdateTimeMs = 999L,
        )
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        assertNull(state.positionMs)
    }

    @Test fun albumArtUriPreferredOverArtUriWhenBothPresent() {
        val snap = snapshot("com.spotify.music", RawPlaybackState.PLAYING).copy(
            artUri = "https://cdn.example/art-small.jpg", albumArtUri = "https://cdn.example/art-album.jpg"
        )
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        assertEquals("https://cdn.example/art-album.jpg", state.artwork)
    }

    @Test fun artUriUsedWhenAlbumArtUriAbsent() {
        val snap = snapshot("com.spotify.music", RawPlaybackState.PLAYING).copy(
            artUri = "https://cdn.example/art-small.jpg", albumArtUri = null
        )
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        assertEquals("https://cdn.example/art-small.jpg", state.artwork)
    }
}

class NormalizedCurrentPositionTest {
    @Test fun playingAdvancesAnchorByElapsedRealtime() {
        assertEquals(35_000L, PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.PLAYING, 105_000L))
    }
    @Test fun pausedStaysFrozenAtAnchor() {
        assertEquals(30_000L, PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.PAUSED, 105_000L))
    }
    @Test fun transitionalStaysFrozenAtAnchor() {
        assertEquals(30_000L, PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.TRANSITIONAL, 105_000L))
    }
    @Test fun playingWithZeroElapsedReturnsAnchorUnchanged() {
        assertEquals(30_000L, PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.PLAYING, 100_000L))
    }
    @Test fun neverRunsTimeBackwards() {
        assertEquals(30_000L, PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.PLAYING, 99_000L))
    }
    @Test fun unknownSentinelStaysNullEvenWhilePlaying() {
        assertNull(PositionNormalizer.normalizedNow(-1L, 100_000L, RawPlaybackState.PLAYING, 105_000L))
    }
    @Test fun zeroUpdateTimestampStaysNullEvenWhilePlaying() {
        assertNull(PositionNormalizer.normalizedNow(30_000L, 0L, RawPlaybackState.PLAYING, 105_000L))
    }
    @Test fun positionZeroWhilePlayingAdvancesCorrectly() {
        assertEquals(2_500L, PositionNormalizer.normalizedNow(0L, 100_000L, RawPlaybackState.PLAYING, 102_500L))
    }
    @Test fun positionZeroWhilePausedStaysZeroNotNull() {
        assertEquals(0L, PositionNormalizer.normalizedNow(0L, 100_000L, RawPlaybackState.PAUSED, 105_000L))
    }
}

class SamePackageDifferentSessionTest {
    @Test fun twoSessionsFromSamePackageAreDistinctAndPlayingOneWins() {
        val playing = snapshot("com.spotify.music", RawPlaybackState.PLAYING, sessionId = "spotify-session-B", osPriorityIndex = 1)
        val paused = snapshot("com.spotify.music", RawPlaybackState.PAUSED, sessionId = "spotify-session-A", osPriorityIndex = 0)
        assertEquals("spotify-session-B", ActiveSessionSelector.select(listOf(paused, playing), null))
    }
    @Test fun stickinessDoesNotTransferBetweenSessionsOfSamePackage() {
        val other = snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL, sessionId = "spotify-session-B")
        assertNull(ActiveSessionSelector.select(listOf(other), "spotify-session-A"))
    }
    @Test fun correctSamePackageSessionSticksWhileSiblingPaused() {
        val a = snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL, sessionId = "spotify-session-A", osPriorityIndex = 0)
        val b = snapshot("com.spotify.music", RawPlaybackState.PAUSED, sessionId = "spotify-session-B", osPriorityIndex = 1)
        assertEquals("spotify-session-A", ActiveSessionSelector.select(listOf(a, b), "spotify-session-A"))
    }
}

class TitleNormalizerTest {
    private val YT = "youtube_android"
    private val SP = "spotify_android"

    @Test fun exactRealDeviceCase() {
        assertEquals("The Sentinel",
            TitleNormalizer.normalizeTrack(YT, "Judas Priest - The Sentinel (Official Audio)", "Judas Priest"))
    }
    @Test fun enDashSeparator() {
        assertEquals("The Sentinel",
            TitleNormalizer.normalizeTrack(YT, "Judas Priest \u2013 The Sentinel", "Judas Priest"))
    }
    @Test fun emDashSeparator() {
        assertEquals("The Sentinel",
            TitleNormalizer.normalizeTrack(YT, "Judas Priest \u2014 The Sentinel", "Judas Priest"))
    }
    @Test fun officialVideoSuffixRemoved() {
        assertEquals("Painkiller",
            TitleNormalizer.normalizeTrack(YT, "Judas Priest - Painkiller (Official Video)", "Judas Priest"))
    }
    @Test fun bracketFormSuffixRemoved() {
        assertEquals("Ashes in the Snow",
            TitleNormalizer.normalizeTrack(YT, "Mono - Ashes in the Snow [Official Music Video]", "Mono"))
    }
    @Test fun suffixMatchingIsCaseInsensitive() {
        assertEquals("Ashes in the Snow",
            TitleNormalizer.normalizeTrack(YT, "Mono - Ashes in the Snow (OFFICIAL AUDIO)", "Mono"))
    }
    @Test fun legitimateParenthesesAreNotRemoved() {
        assertEquals("Ashes in the Snow (Live at Sydney Opera House)",
            TitleNormalizer.normalizeTrack(YT, "Mono - Ashes in the Snow (Live at Sydney Opera House)", "Mono"))
    }
    @Test fun resemblingPrefixIsNotStripped() {
        assertEquals("Judas Priestess - Some Song",
            TitleNormalizer.normalizeTrack(YT, "Judas Priestess - Some Song", "Judas Priest"))
    }
    @Test fun unrelatedTitleIsNeverSplitOnHyphen() {
        assertEquals("Live 1982 - Full Concert",
            TitleNormalizer.normalizeTrack(YT, "Live 1982 - Full Concert", "Judas Priest"))
    }
    @Test fun unknownParentheticalSurvives() {
        assertEquals("The Sentinel (Remastered 2015)",
            TitleNormalizer.normalizeTrack(YT, "Judas Priest - The Sentinel (Remastered 2015)", "Judas Priest"))
    }
    @Test fun spotifyTitleWithHyphenIsUntouched() {
        assertEquals("Judas Priest - The Sentinel (Official Audio)",
            TitleNormalizer.normalizeTrack(SP, "Judas Priest - The Sentinel (Official Audio)", "Judas Priest"))
    }
    @Test fun spotifyNormalTitleUntouched() {
        assertEquals("Space-Dye Vest", TitleNormalizer.normalizeTrack(SP, "Space-Dye Vest", "Dream Theater"))
    }
    @Test fun nullTitleStaysNull() {
        assertNull(TitleNormalizer.normalizeTrack(YT, null, "Judas Priest"))
    }
    @Test fun nullArtistStillAllowsSuffixCleanup() {
        assertEquals("The Sentinel", TitleNormalizer.normalizeTrack(YT, "The Sentinel (Official Audio)", null))
    }
    @Test fun blankArtistStripsNothingAsPrefix() {
        assertEquals("Judas Priest - The Sentinel",
            TitleNormalizer.normalizeTrack(YT, "Judas Priest - The Sentinel", "   "))
    }
    @Test fun artistPlusSeparatorOnlyIsLeftAlone() {
        assertEquals("Judas Priest -", TitleNormalizer.normalizeTrack(YT, "Judas Priest -", "Judas Priest"))
    }
    @Test fun suffixOnlyTitleIsLeftAlone() {
        assertEquals("(Official Audio)", TitleNormalizer.normalizeTrack(YT, "(Official Audio)", "Judas Priest"))
    }
    @Test fun repeatedKnownSuffixesBothRemoved() {
        assertEquals("The Sentinel",
            TitleNormalizer.normalizeTrack(YT, "Judas Priest - The Sentinel (Official Video) (Lyric Video)", "Judas Priest"))
    }
    @Test fun unknownSourceLeavesTitleUntouched() {
        assertEquals("Judas Priest - The Sentinel (Official Audio)",
            TitleNormalizer.normalizeTrack("android_media", "Judas Priest - The Sentinel (Official Audio)", "Judas Priest"))
    }
    @Test fun endToEndYouTubeCleansTrackButKeepsRawAndArtist() {
        val snap = snapshot("com.google.android.youtube", RawPlaybackState.PLAYING,
            artist = "Judas Priest", track = "Judas Priest - The Sentinel (Official Audio)",
            durationMsRaw = 304_000L, positionRaw = 39_364L, lastPositionUpdateTimeMs = 100_000L)
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 100_000L)
        assertEquals("The Sentinel", state.track)
        assertEquals("Judas Priest", state.artist)
        assertEquals("Judas Priest - The Sentinel (Official Audio)", snap.track)
    }
    @Test fun endToEndSpotifyTrackCompletelyUnchanged() {
        val snap = snapshot("com.spotify.music", RawPlaybackState.PLAYING,
            artist = "Dream Theater", track = "Space-Dye Vest",
            durationMsRaw = 449_000L, positionRaw = 178_961L, lastPositionUpdateTimeMs = 100_000L)
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 100_000L)
        assertEquals("Space-Dye Vest", state.track)
    }
}

// ---- Phase 1B-2 transport ----

private fun stateOf(playing: Boolean, pos: Long?, dur: Long? = 300_000L) =
    com.listeningmirror.companion.model.CurrentListeningState(
        source = "spotify_android", artist = "A", primaryArtist = "A", track = "T",
        album = null, artwork = null, isPlaying = playing, durationMs = dur,
        positionMs = pos, externalId = null, externalUrl = null, confidence = null,
        capturedAt = "2026-01-01T00:00:00.000Z", controlsSupported = false)

class PositionReanchorTest {
    @Test fun heartbeatAdvancesPlayingPosition() {
        val s = com.listeningmirror.companion.transport.PositionReanchor
            .reanchor(stateOf(true, 30_000L), 20_000L, "HB")
        assertEquals(50_000L, s.positionMs)
        assertEquals("HB", s.capturedAt)
    }
    @Test fun heartbeatPreservesNullPosition() {
        val s = com.listeningmirror.companion.transport.PositionReanchor
            .reanchor(stateOf(true, null), 20_000L, "HB")
        assertNull(s.positionMs)
        assertEquals("HB", s.capturedAt)
    }
    @Test fun pausedPositionDoesNotAdvance() {
        val s = com.listeningmirror.companion.transport.PositionReanchor
            .reanchor(stateOf(false, 30_000L), 20_000L, "HB")
        assertEquals(30_000L, s.positionMs)
        assertEquals("HB", s.capturedAt)
    }
    @Test fun heartbeatClampsToDuration() {
        val s = com.listeningmirror.companion.transport.PositionReanchor
            .reanchor(stateOf(true, 295_000L, 300_000L), 20_000L, "HB")
        assertEquals(300_000L, s.positionMs)
    }
    @Test fun unknownDurationStillAdvances() {
        val s = com.listeningmirror.companion.transport.PositionReanchor
            .reanchor(stateOf(true, 30_000L, null), 20_000L, "HB")
        assertEquals(50_000L, s.positionMs)
    }
    @Test fun negativeDeltaNeverRunsBackwards() {
        val s = com.listeningmirror.companion.transport.PositionReanchor
            .reanchor(stateOf(true, 30_000L), -5_000L, "HB")
        assertEquals(30_000L, s.positionMs)
    }
}

class ArtworkPolicyTest {
    private val p = com.listeningmirror.companion.transport.ArtworkPolicy
    @Test fun httpsAllowed() { assertEquals("https://x/a.jpg", p.browserSafeArtwork("https://x/a.jpg")) }
    @Test fun httpAllowed() { assertEquals("http://x/a.jpg", p.browserSafeArtwork("http://x/a.jpg")) }
    @Test fun contentUriRejected() { assertNull(p.browserSafeArtwork("content://media/album/12")) }
    @Test fun fileUriRejected() { assertNull(p.browserSafeArtwork("file:///sdcard/a.jpg")) }
    @Test fun nullStaysNull() { assertNull(p.browserSafeArtwork(null)) }
    @Test fun schemeIsCaseInsensitive() { assertEquals("HTTPS://x/a.jpg", p.browserSafeArtwork("HTTPS://x/a.jpg")) }
}

// ---- Phase 1C: foreground keepalive lifecycle ----
//
// The keepalive follows the LISTENER CONNECTION, never playback state.
// Gating it on isPlaying would recreate on Android the same class of
// disappear-on-pause bug that mirror.js's MAX_TOLERATED_MISSES prevents
// on the web side.

class KeepaliveLifecycleTest {

    @Test fun notRunningBeforeListenerConnects() {
        assertFalse(KeepaliveLifecycle.State().keepaliveRunning)
    }
    @Test fun runsOnceListenerConnects() {
        assertTrue(KeepaliveLifecycle.next(KeepaliveLifecycle.State(), KeepaliveLifecycle.Event.LISTENER_CONNECTED).keepaliveRunning)
    }
    @Test fun survivesEveryPlaybackEvent() {
        var s = KeepaliveLifecycle.next(KeepaliveLifecycle.State(), KeepaliveLifecycle.Event.LISTENER_CONNECTED)
        for (e in listOf(KeepaliveLifecycle.Event.PLAYBACK_STARTED, KeepaliveLifecycle.Event.PLAYBACK_PAUSED,
                         KeepaliveLifecycle.Event.SELECTION_BECAME_NULL, KeepaliveLifecycle.Event.TRACK_CHANGED,
                         KeepaliveLifecycle.Event.SOURCE_SWITCHED)) {
            s = KeepaliveLifecycle.next(s, e)
            assertTrue(s.keepaliveRunning)
        }
    }
    @Test fun reconnectIsIdempotent() {
        var s = KeepaliveLifecycle.next(KeepaliveLifecycle.State(), KeepaliveLifecycle.Event.LISTENER_CONNECTED)
        s = KeepaliveLifecycle.next(s, KeepaliveLifecycle.Event.LISTENER_CONNECTED)
        assertTrue(s.keepaliveRunning)
    }
    @Test fun stopsOnListenerDisconnect() {
        var s = KeepaliveLifecycle.next(KeepaliveLifecycle.State(), KeepaliveLifecycle.Event.LISTENER_CONNECTED)
        assertFalse(KeepaliveLifecycle.next(s, KeepaliveLifecycle.Event.LISTENER_DISCONNECTED).keepaliveRunning)
    }
    @Test fun destroyWithoutPriorDisconnectStillStops() {
        assertFalse(KeepaliveLifecycle.next(KeepaliveLifecycle.State(listenerConnected = true), KeepaliveLifecycle.Event.DESTROYED).keepaliveRunning)
    }
    @Test fun repeatedTeardownIsIdempotent() {
        var s = KeepaliveLifecycle.next(KeepaliveLifecycle.State(listenerConnected = true), KeepaliveLifecycle.Event.LISTENER_DISCONNECTED)
        s = KeepaliveLifecycle.next(s, KeepaliveLifecycle.Event.DESTROYED)
        s = KeepaliveLifecycle.next(s, KeepaliveLifecycle.Event.LISTENER_DISCONNECTED)
        assertFalse(s.keepaliveRunning)
    }
}

// ---- Phase 1C.1: YouTube metadata resolver ----

class YouTubeMetadataResolverTest {
    @Test fun uploaderIsNotTreatedAsMusicalArtist() {
        val r = YouTubeMetadataResolver.resolve(
            "Rock & Roll Hall of Fame",
            "2021 Remaster \"While My Guitar Gently Weeps\" Prince, Tom Petty & More | Rock Hall 2004 Induction",
            null)
        assertNull(r.artist)
        assertFalse(r.artistIsCanonical)
        assertEquals(Provenance.YOUTUBE_UPLOADER, r.artistProvenance)
    }
    @Test fun strongTitleParse() {
        val r = YouTubeMetadataResolver.resolve("Gorillaz", "Gorillaz - Feel Good Inc. (Official Video)", null)
        assertEquals("Gorillaz", r.artist)
        assertEquals("Feel Good Inc.", r.track)
        assertTrue(r.artistIsCanonical)
    }
    @Test fun topicChannelIsStrongEvidence() {
        val r = YouTubeMetadataResolver.resolve("Gorillaz - Topic", "Feel Good Inc.", null)
        assertEquals("Gorillaz", r.artist)
        assertEquals(Provenance.YOUTUBE_TOPIC_CHANNEL, r.artistProvenance)
    }
    @Test fun ambiguousStaysUnresolved() {
        assertNull(YouTubeMetadataResolver.resolve("Some Channel", "Live 1982 - Full Concert", null).artist)
        assertNull(YouTubeMetadataResolver.resolve("Some Channel", "Just A Video Title", null).artist)
    }
    @Test fun existingJudasPriestCasePreserved() {
        val r = YouTubeMetadataResolver.resolve("Judas Priest", "Judas Priest - The Sentinel (Official Audio)", null)
        assertEquals("Judas Priest", r.artist)
        assertEquals("The Sentinel", r.track)
    }
    @Test fun officialWordsInMiddleDoNotMakeArtistCanonical() {
        val r = YouTubeMetadataResolver.resolve("SomeChannel", "My reaction to official video - Gorillaz", null)
        assertNull(r.artist)
        assertFalse(r.artistIsCanonical)
    }
    @Test fun mixedSeparatorUploaderPrefixStillResolves() {
        val r = YouTubeMetadataResolver.resolve("Judas Priest", "Judas Priest – The Sentinel - 2021", null)
        assertEquals("Judas Priest", r.artist)
        assertEquals("The Sentinel - 2021", r.track)
    }
    @Test fun radioNovaRealDeviceTitleFindsActualArtist() {
        val r = YouTubeMetadataResolver.resolve("Radio Nova", "Ezechiel Pailhes - Éternel été | Live Plus Près De Toi", null)
        assertEquals("Ezechiel Pailhes", r.artist)
        assertEquals("Éternel été | Live Plus Près De Toi", r.track)
        assertEquals("Radio Nova", r.uploaderCandidate)
        assertTrue(r.artistIsCanonical)
    }
    @Test fun liveDescriptorIsNotPromotedByGenericArtistTrackRule() {
        val r = YouTubeMetadataResolver.resolve("Some Channel", "Live 1982 - Full Concert", null)
        assertNull(r.artist)
    }
}

class ArtworkResolverTest {
    @Test fun httpsUriPreserved() {
        val a = ArtworkResolver.resolve("youtube_android", "https://i.ytimg.com/vi/x/hq.jpg", null, false)
        assertEquals("https://i.ytimg.com/vi/x/hq.jpg", a.url)
        assertEquals(ArtworkKind.SOURCE_URI, a.kind)
    }
    @Test fun bitmapIsNotSerialized() {
        val a = ArtworkResolver.resolve("youtube_android", "content://media/album/1", null, true)
        assertNull(a.url)
        assertEquals(ArtworkKind.NONE, a.kind)
    }
    @Test fun verifiedYouTubeUrlYieldsThumbnail() {
        val a = ArtworkResolver.resolve("youtube_android", null, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", false)
        assertEquals("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", a.url)
        assertEquals(ArtworkKind.VIDEO_THUMBNAIL, a.kind)
    }
    @Test fun musicYouTubeUrlYieldsThumbnail() {
        val a = ArtworkResolver.resolve("youtube_music_android", null, "https://music.youtube.com/watch?v=dQw4w9WgXcQ", false)
        assertEquals("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", a.url)
        assertEquals(ArtworkKind.VIDEO_THUMBNAIL, a.kind)
    }
    @Test fun bareIdIsNotVerification() {
        assertNull(ArtworkResolver.verifiedYouTubeVideoId("dQw4w9WgXcQ"))
    }
    @Test fun nonYouTubeUrlRejected() {
        assertNull(ArtworkResolver.verifiedYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"))
    }
}

class AmbientTimecodeTest {
    @Test fun parsesMinutesSeconds() { assertEquals(152_000L, AmbientTimecode.parseMs("02:32")) }
    @Test fun parsesHoursMinutesSeconds() { assertEquals(3_723_000L, AmbientTimecode.parseMs("01:02:03")) }
    @Test fun rejectsMalformedTimecode() {
        assertNull(AmbientTimecode.parseMs(null))
        assertNull(AmbientTimecode.parseMs("abc"))
        assertNull(AmbientTimecode.parseMs("01:99"))
        assertNull(AmbientTimecode.parseMs("01:70:02"))
    }
}

class AmbientSourceSelectorTest {
    private fun state(source: String, playing: Boolean) = CurrentListeningState(
        source = source,
        artist = "Artist",
        primaryArtist = "Artist",
        track = "Track",
        album = null,
        artwork = null,
        isPlaying = playing,
        durationMs = 200_000L,
        positionMs = 10_000L,
        externalId = source,
        externalUrl = null,
        confidence = null,
        capturedAt = "2026-01-01T00:00:00.000Z",
        controlsSupported = false,
    )

    @Test fun activeDevicePlaybackWinsOverAmbient() {
        val media = state("youtube_android", true)
        val ambient = state("ambient_audd", true)
        assertEquals(media, AmbientSourceSelector.choose(media, ambient))
    }

    @Test fun ambientWinsOverPausedDeviceSession() {
        val media = state("spotify_android", false)
        val ambient = state("ambient_audd", true)
        assertEquals(ambient, AmbientSourceSelector.choose(media, ambient))
    }

    @Test fun pausedDeviceStateRemainsWhenAmbientAbsent() {
        val media = state("spotify_android", false)
        assertEquals(media, AmbientSourceSelector.choose(media, null))
    }

    @Test fun ambientWorksWithNoDeviceSession() {
        val ambient = state("ambient_audd", true)
        assertEquals(ambient, AmbientSourceSelector.choose(null, ambient))
    }
}



class Pcm16SignalAnalyzerTest {
    @Test fun silenceIsRejected() {
        val stats = Pcm16SignalAnalyzer.analyze(ByteArray(8_820))
        assertFalse(stats.isUsable(-55.0, -42.0))
    }

    @Test fun strongToneLikeSignalIsUsable() {
        val pcm = ByteArray(8_820)
        var i = 0
        var sign = 1
        while (i + 1 < pcm.size) {
            val sample = 8_000 * sign
            pcm[i] = (sample and 0xff).toByte()
            pcm[i + 1] = ((sample shr 8) and 0xff).toByte()
            sign = -sign
            i += 2
        }
        val stats = Pcm16SignalAnalyzer.analyze(pcm)
        assertTrue(stats.isUsable(-55.0, -42.0))
        assertTrue(stats.rmsDbfs > -20.0)
        assertTrue(stats.peakDbfs > -20.0)
    }

    @Test fun oddTrailingByteIsIgnored() {
        val stats = Pcm16SignalAnalyzer.analyze(byteArrayOf(0, 1, 99))
        assertEquals(1L, stats.sampleCount)
    }
}

class AmbientPositionAnchorTest {
    @Test fun advancesFromCaptureStartToResponse() {
        assertEquals(114_250L, AmbientPositionAnchor.atResponse(105_000L, 9_250L, 257_000L))
    }

    @Test fun clampsAtDuration() {
        assertEquals(257_000L, AmbientPositionAnchor.atResponse(250_000L, 12_000L, 257_000L))
    }

    @Test fun unknownTimecodeStaysUnknown() {
        assertNull(AmbientPositionAnchor.atResponse(null, 9_000L, 257_000L))
    }

    @Test fun negativeElapsedDoesNotRewind() {
        assertEquals(105_000L, AmbientPositionAnchor.atResponse(105_000L, -500L, 257_000L))
    }
}
