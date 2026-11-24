import com.listeningmirror.companion.logic.ActiveSessionSelector
import com.listeningmirror.companion.logic.AmbientSourceSelector
import com.listeningmirror.companion.logic.AmbientTimecode
import com.listeningmirror.companion.ambient.ShazamFingerprint
import com.listeningmirror.companion.logic.AmbientPositionAnchor
import com.listeningmirror.companion.logic.DurationNormalizer
import com.listeningmirror.companion.logic.MetadataCompleteness
import com.listeningmirror.companion.logic.PositionNormalizer
import com.listeningmirror.companion.logic.SourceMapper
import com.listeningmirror.companion.logic.ArtworkKind
import com.listeningmirror.companion.logic.ArtworkResolver
import com.listeningmirror.companion.logic.Provenance
import com.listeningmirror.companion.logic.StateNormalizer
import com.listeningmirror.companion.logic.YouTubeMetadataResolver
import com.listeningmirror.companion.logic.TitleNormalizer
import com.listeningmirror.companion.model.CurrentListeningState
import com.listeningmirror.companion.android.KeepaliveLifecycle
import com.listeningmirror.companion.transport.ArtworkPolicy
import com.listeningmirror.companion.transport.PositionReanchor
import com.listeningmirror.companion.model.RawPlaybackState
import com.listeningmirror.companion.model.RawSessionSnapshot
import java.util.Base64
import java.util.zip.CRC32
import kotlin.math.PI
import kotlin.math.sin

var pass = 0
var fail = 0
fun check(label: String, cond: Boolean) {
    if (cond) { pass++; println("ok   $label") }
    else { fail++; println("FAIL $label") }
}

fun snapshot(
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
    artUri: String? = null,
    albumArtUri: String? = null,
): RawSessionSnapshot = RawSessionSnapshot(
    sessionId = sessionId, packageName = packageName, playbackState = state, rawPlaybackStateInt = null,
    artist = artist, track = track, album = album,
    mediaId = null, mediaUri = null, artUri = artUri, albumArtUri = albumArtUri,
    hasArtBitmap = false, hasAlbumArtBitmap = false,
    durationMsRaw = durationMsRaw, positionRaw = positionRaw, lastPositionUpdateTimeMs = lastPositionUpdateTimeMs,
    playbackSpeed = 1.0f, osPriorityIndex = osPriorityIndex,
)

fun main() {
    // ---- SourceMapper ----
    check("spotify package -> spotify_android", SourceMapper.sourceFor("com.spotify.music") == "spotify_android")
    check("youtube package -> youtube_android", SourceMapper.sourceFor("com.google.android.youtube") == "youtube_android")
    check("youtube music package -> youtube_music_android", SourceMapper.sourceFor("com.google.android.apps.youtube.music") == "youtube_music_android")
    check("unknown package -> android_media", SourceMapper.sourceFor("com.example.somerandomapp") == "android_media")
    check("empty package name does not crash, falls back to android_media", SourceMapper.sourceFor("") == "android_media")

    // ---- PositionNormalizer ----
    check("valid position + valid timestamp accepted", PositionNormalizer.validAnchorOrNull(45_000L, 999L) == 45_000L)
    check("zero position is valid", PositionNormalizer.validAnchorOrNull(0L, 999L) == 0L)
    check("PLAYBACK_POSITION_UNKNOWN (-1) rejected", PositionNormalizer.validAnchorOrNull(-1L, 999L) == null)
    check("other negative position rejected", PositionNormalizer.validAnchorOrNull(-500L, 999L) == null)
    check("zero update timestamp (never set) rejected", PositionNormalizer.validAnchorOrNull(45_000L, 0L) == null)
    check("null update timestamp rejected", PositionNormalizer.validAnchorOrNull(45_000L, null) == null)
    check("null position rejected", PositionNormalizer.validAnchorOrNull(null, 999L) == null)
    check("position 0 + timestamp 0 (both edge cases at once) still rejected", PositionNormalizer.validAnchorOrNull(0L, 0L) == null)

    // ---- DurationNormalizer ----
    check("valid duration accepted", DurationNormalizer.normalize(200_000L) == 200_000L)
    check("negative duration -> null (unknown per MediaMetadata contract)", DurationNormalizer.normalize(-1L) == null)
    check("null duration -> null", DurationNormalizer.normalize(null) == null)
    check("zero duration accepted as-is", DurationNormalizer.normalize(0L) == 0L)

    // ---- MetadataCompleteness ----
    check("both artist+track present -> complete", MetadataCompleteness.isCompleteForLyrics("Mono", "Ashes in the Snow"))
    check("missing artist -> incomplete", !MetadataCompleteness.isCompleteForLyrics(null, "Track"))
    check("missing track -> incomplete", !MetadataCompleteness.isCompleteForLyrics("Artist", null))
    check("blank artist -> incomplete", !MetadataCompleteness.isCompleteForLyrics("   ", "Track"))
    check("blank track -> incomplete", !MetadataCompleteness.isCompleteForLyrics("Artist", ""))
    check("both missing -> incomplete", !MetadataCompleteness.isCompleteForLyrics(null, null))

    // ---- ActiveSessionSelector ----
    check("empty session list selects nothing", ActiveSessionSelector.select(emptyList(), null) == null)

    check("single playing session is selected",
        ActiveSessionSelector.select(listOf(snapshot("com.spotify.music", RawPlaybackState.PLAYING)), null) == "session-of-com.spotify.music")

    check("playing beats paused", ActiveSessionSelector.select(
        listOf(
            snapshot("com.spotify.music", RawPlaybackState.PAUSED, osPriorityIndex = 0),
            snapshot("com.google.android.youtube", RawPlaybackState.PLAYING, osPriorityIndex = 1),
        ), "session-of-com.spotify.music"
    ) == "session-of-com.google.android.youtube")

    check("OS priority order breaks ties between multiple playing sessions", ActiveSessionSelector.select(
        listOf(
            snapshot("com.google.android.youtube", RawPlaybackState.PLAYING, osPriorityIndex = 1),
            snapshot("com.spotify.music", RawPlaybackState.PLAYING, osPriorityIndex = 0),
        ), null
    ) == "session-of-com.spotify.music")

    check("transitional state is sticky if previously selected", ActiveSessionSelector.select(
        listOf(snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL)), "session-of-com.spotify.music"
    ) == "session-of-com.spotify.music")

    check("transitional state does NOT stick if it was not previously selected", ActiveSessionSelector.select(
        listOf(snapshot("com.google.android.youtube", RawPlaybackState.TRANSITIONAL)), "session-of-com.spotify.music"
    ) == null)

    check("does not flap to a stale paused session during previous selection's buffering (THE exact correction #3 scenario)",
        ActiveSessionSelector.select(
            listOf(
                snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL, osPriorityIndex = 0),
                snapshot("com.google.android.youtube", RawPlaybackState.PAUSED, osPriorityIndex = 1),
            ), "session-of-com.spotify.music"
        ) == "session-of-com.spotify.music")

    check("previously selected session gone entirely -> no stickiness", ActiveSessionSelector.select(
        listOf(snapshot("com.google.android.youtube", RawPlaybackState.PAUSED)), "session-of-com.spotify.music"
    ) == null)

    check("all paused with no previous selection -> nothing selected", ActiveSessionSelector.select(
        listOf(
            snapshot("com.spotify.music", RawPlaybackState.PAUSED),
            snapshot("com.google.android.youtube", RawPlaybackState.STOPPED),
        ), null
    ) == null)

    check("newly playing session overrides old transitional stickiness", ActiveSessionSelector.select(
        listOf(
            snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL, osPriorityIndex = 0),
            snapshot("com.google.android.youtube", RawPlaybackState.PLAYING, osPriorityIndex = 1),
        ), "session-of-com.spotify.music"
    ) == "session-of-com.google.android.youtube")

    // ---- StateNormalizer ----
    run {
        val snap = snapshot(
            "com.spotify.music", RawPlaybackState.PLAYING,
            artist = "Mono", track = "Ashes in the Snow", album = "Hymn to the Immortal Wind",
            durationMsRaw = 300_000L, positionRaw = 45_000L, lastPositionUpdateTimeMs = 111L,
        )
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        check("normalizes a fully populated Spotify snapshot: source", state.source == "spotify_android")
        check("normalizes a fully populated Spotify snapshot: artist", state.artist == "Mono")
        check("normalizes a fully populated Spotify snapshot: primaryArtist mirrors artist", state.primaryArtist == "Mono")
        check("normalizes a fully populated Spotify snapshot: track", state.track == "Ashes in the Snow")
        check("normalizes a fully populated Spotify snapshot: durationMs", state.durationMs == 300_000L)
        check("normalizes a fully populated Spotify snapshot: positionMs advanced to capturedAt (45000 + (200000-111))", state.positionMs == 45_000L + (200_000L - 111L))
        check("normalizes a fully populated Spotify snapshot: isPlaying", state.isPlaying)
        check("normalizes a fully populated Spotify snapshot: controlsSupported is false in this phase", !state.controlsSupported)
        check("normalizes a fully populated Spotify snapshot: confidence is null (not invented)", state.confidence == null)
    }

    run {
        val snap = snapshot(
            "com.example.unknownapp", RawPlaybackState.PAUSED,
            artist = null, track = null, album = null,
            durationMsRaw = null, positionRaw = null, lastPositionUpdateTimeMs = null,
        )
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        check("missing metadata never crashes normalization (artist null)", state.artist == null)
        check("missing metadata never crashes normalization (track null)", state.track == null)
        check("missing metadata never crashes normalization (durationMs null)", state.durationMs == null)
        check("missing metadata never crashes normalization (positionMs null)", state.positionMs == null)
        check("missing metadata never crashes normalization (source still android_media)", state.source == "android_media")
    }

    run {
        val snap = snapshot(
            "com.spotify.music", RawPlaybackState.PLAYING,
            positionRaw = PositionNormalizer.PLAYBACK_POSITION_UNKNOWN, lastPositionUpdateTimeMs = 999L,
        )
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        check("unknown position sentinel never leaks into normalized state", state.positionMs == null)
    }

    run {
        val snap = snapshot("com.spotify.music", RawPlaybackState.PLAYING, artUri = "content://art/small", albumArtUri = "content://art/album")
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        // content:// is not loadable by a browser, so resolution now yields
        // null at THIS layer rather than passing a dead URI downstream to be
        // filtered later. The raw URIs remain visible on the debug screen.
        check("content:// artwork resolves to null (single resolution point)", state.artwork == null)
    }

    run {
        val snap = snapshot("com.spotify.music", RawPlaybackState.PLAYING, artUri = "content://art/small", albumArtUri = null)
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        check("content:// artUri also resolves to null", state.artwork == null)
    }


    // ---- NEW: normalized current position (correction #2) ----
    check("PLAYING advances the anchor by elapsed realtime since lastPositionUpdateTime",
        PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.PLAYING, 105_000L) == 35_000L)
    check("PAUSED stays frozen at its anchor, ignoring elapsed time",
        PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.PAUSED, 105_000L) == 30_000L)
    check("TRANSITIONAL (buffering) also stays frozen at its anchor",
        PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.TRANSITIONAL, 105_000L) == 30_000L)
    check("PLAYING with zero elapsed returns the anchor unchanged",
        PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.PLAYING, 100_000L) == 30_000L)
    check("PLAYING never runs time backwards if the update timestamp is ahead of our clock reading",
        PositionNormalizer.normalizedNow(30_000L, 100_000L, RawPlaybackState.PLAYING, 99_000L) == 30_000L)
    check("unknown sentinel stays null even while PLAYING (never advanced into a fake position)",
        PositionNormalizer.normalizedNow(-1L, 100_000L, RawPlaybackState.PLAYING, 105_000L) == null)
    check("zero update timestamp stays null even while PLAYING",
        PositionNormalizer.normalizedNow(30_000L, 0L, RawPlaybackState.PLAYING, 105_000L) == null)
    check("position 0 while PLAYING correctly advances (track just started)",
        PositionNormalizer.normalizedNow(0L, 100_000L, RawPlaybackState.PLAYING, 102_500L) == 2_500L)
    check("position 0 while PAUSED stays exactly 0 (valid, not null)",
        PositionNormalizer.normalizedNow(0L, 100_000L, RawPlaybackState.PAUSED, 105_000L) == 0L)

    // ---- NEW: same package, different sessions must not collapse ----
    run {
        val playingSession = snapshot("com.spotify.music", RawPlaybackState.PLAYING, sessionId = "spotify-session-B", osPriorityIndex = 1)
        val pausedSession = snapshot("com.spotify.music", RawPlaybackState.PAUSED, sessionId = "spotify-session-A", osPriorityIndex = 0)
        check("two sessions from the SAME package are treated as distinct; the genuinely playing one wins",
            ActiveSessionSelector.select(listOf(pausedSession, playingSession), null) == "spotify-session-B")
    }
    run {
        // Stickiness must key on the SESSION, not the package: session A of
        // Spotify buffering must not be satisfied by session B of Spotify.
        val otherSession = snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL, sessionId = "spotify-session-B")
        check("transitional stickiness does not transfer between two sessions of the same package",
            ActiveSessionSelector.select(listOf(otherSession), "spotify-session-A") == null)
    }
    run {
        val a = snapshot("com.spotify.music", RawPlaybackState.TRANSITIONAL, sessionId = "spotify-session-A", osPriorityIndex = 0)
        val b = snapshot("com.spotify.music", RawPlaybackState.PAUSED, sessionId = "spotify-session-B", osPriorityIndex = 1)
        check("correct same-package session sticks while its sibling is paused",
            ActiveSessionSelector.select(listOf(a, b), "spotify-session-A") == "spotify-session-A")
    }


    // ---- NEW: conservative YouTube title normalization ----
    val YT = "youtube_android"
    val SP = "spotify_android"

    check("YT: exact real-device case -> 'The Sentinel'",
        TitleNormalizer.normalizeTrack(YT, "Judas Priest - The Sentinel (Official Audio)", "Judas Priest") == "The Sentinel")
    check("YT: en dash separator",
        TitleNormalizer.normalizeTrack(YT, "Judas Priest \u2013 The Sentinel", "Judas Priest") == "The Sentinel")
    check("YT: em dash separator",
        TitleNormalizer.normalizeTrack(YT, "Judas Priest \u2014 The Sentinel", "Judas Priest") == "The Sentinel")
    check("YT: (Official Video) suffix removed",
        TitleNormalizer.normalizeTrack(YT, "Judas Priest - Painkiller (Official Video)", "Judas Priest") == "Painkiller")
    check("YT: [Official Music Video] bracket form removed",
        TitleNormalizer.normalizeTrack(YT, "Mono - Ashes in the Snow [Official Music Video]", "Mono") == "Ashes in the Snow")
    check("YT: suffix matching is case-insensitive",
        TitleNormalizer.normalizeTrack(YT, "Mono - Ashes in the Snow (OFFICIAL AUDIO)", "Mono") == "Ashes in the Snow")

    // The critical safety cases -- must NOT strip
    check("YT: legitimate parentheses are NOT removed",
        TitleNormalizer.normalizeTrack(YT, "Mono - Ashes in the Snow (Live at Sydney Opera House)", "Mono") == "Ashes in the Snow (Live at Sydney Opera House)")
    check("YT: a title merely RESEMBLING the artist prefix is not stripped (no separator follows)",
        TitleNormalizer.normalizeTrack(YT, "Judas Priestess - Some Song", "Judas Priest") == "Judas Priestess - Some Song")
    check("YT: unrelated leading text is never split on its hyphen",
        TitleNormalizer.normalizeTrack(YT, "Live 1982 - Full Concert", "Judas Priest") == "Live 1982 - Full Concert")
    check("YT: arbitrary parenthetical not on the known list survives",
        TitleNormalizer.normalizeTrack(YT, "Judas Priest - The Sentinel (Remastered 2015)", "Judas Priest") == "The Sentinel (Remastered 2015)")

    // Spotify must be completely untouched
    check("Spotify: title with a hyphen is left exactly as-is",
        TitleNormalizer.normalizeTrack(SP, "Judas Priest - The Sentinel (Official Audio)", "Judas Priest") == "Judas Priest - The Sentinel (Official Audio)")
    check("Spotify: normal title untouched",
        TitleNormalizer.normalizeTrack(SP, "Space-Dye Vest", "Dream Theater") == "Space-Dye Vest")

    // Degenerate inputs must never produce something worse than the input
    check("YT: null title stays null",
        TitleNormalizer.normalizeTrack(YT, null, "Judas Priest") == null)
    check("YT: null artist means no prefix removal, suffix cleanup still applies",
        TitleNormalizer.normalizeTrack(YT, "The Sentinel (Official Audio)", null) == "The Sentinel")
    check("YT: blank artist does not strip anything as a prefix",
        TitleNormalizer.normalizeTrack(YT, "Judas Priest - The Sentinel", "   ") == "Judas Priest - The Sentinel")
    check("YT: title that is ONLY artist + separator is left alone rather than emptied",
        TitleNormalizer.normalizeTrack(YT, "Judas Priest -", "Judas Priest") == "Judas Priest -")
    check("YT: title that is ONLY a known suffix is left alone rather than emptied",
        TitleNormalizer.normalizeTrack(YT, "(Official Audio)", "Judas Priest") == "(Official Audio)")
    check("YT: repeated known suffixes both removed",
        TitleNormalizer.normalizeTrack(YT, "Judas Priest - The Sentinel (Official Video) (Lyric Video)", "Judas Priest") == "The Sentinel")
    check("YT: unknown source string leaves title untouched",
        TitleNormalizer.normalizeTrack("android_media", "Judas Priest - The Sentinel (Official Audio)", "Judas Priest") == "Judas Priest - The Sentinel (Official Audio)")

    // End-to-end through StateNormalizer, with the real device values
    run {
        val ytSnap = snapshot("com.google.android.youtube", RawPlaybackState.PLAYING,
            artist = "Judas Priest", track = "Judas Priest - The Sentinel (Official Audio)",
            durationMsRaw = 304_000L, positionRaw = 39_364L, lastPositionUpdateTimeMs = 100_000L)
        val st = StateNormalizer.normalize(ytSnap, "2026-01-01T00:00:00.000Z", 100_000L)
        check("end-to-end YT: normalized track cleaned", st.track == "The Sentinel")
        check("end-to-end YT: artist untouched (never inferred from title)", st.artist == "Judas Priest")
        check("end-to-end YT: RAW snapshot title preserved untouched for diagnostics",
            ytSnap.track == "Judas Priest - The Sentinel (Official Audio)")
        check("end-to-end YT: source correct", st.source == "youtube_android")
    }
    run {
        val spSnap = snapshot("com.spotify.music", RawPlaybackState.PLAYING,
            artist = "Dream Theater", track = "Space-Dye Vest",
            durationMsRaw = 449_000L, positionRaw = 178_961L, lastPositionUpdateTimeMs = 100_000L)
        val st = StateNormalizer.normalize(spSnap, "2026-01-01T00:00:00.000Z", 100_000L)
        check("end-to-end Spotify: real-device track completely unchanged", st.track == "Space-Dye Vest")
    }


    // ---- Phase 1B-2: heartbeat position re-anchoring ----
    fun stateOf(playing: Boolean, pos: Long?, dur: Long? = 300_000L) = CurrentListeningState(
        source = "spotify_android", artist = "A", primaryArtist = "A", track = "T", album = null,
        artwork = null, isPlaying = playing, durationMs = dur, positionMs = pos,
        externalId = null, externalUrl = null, confidence = null,
        capturedAt = "2026-01-01T00:00:00.000Z", controlsSupported = false)

    run {
        val s = PositionReanchor.reanchor(stateOf(true, 30_000L), 20_000L, "HB")
        check("REQUIRED: heartbeat ADVANCES a playing position (30000 + 20000)", s.positionMs == 50_000L)
        check("heartbeat refreshes capturedAt to the heartbeat instant", s.capturedAt == "HB")
    }
    run {
        val s = PositionReanchor.reanchor(stateOf(true, null), 20_000L, "HB")
        check("REQUIRED: heartbeat PRESERVES a null position (never invents one)", s.positionMs == null)
        check("null-position heartbeat still refreshes capturedAt", s.capturedAt == "HB")
    }
    run {
        val s = PositionReanchor.reanchor(stateOf(false, 30_000L), 20_000L, "HB")
        check("REQUIRED: paused position does NOT advance", s.positionMs == 30_000L)
        check("paused heartbeat still refreshes capturedAt", s.capturedAt == "HB")
    }
    run {
        val s = PositionReanchor.reanchor(stateOf(true, 295_000L, 300_000L), 20_000L, "HB")
        check("heartbeat clamps to duration instead of running past track end", s.positionMs == 300_000L)
    }
    run {
        val s = PositionReanchor.reanchor(stateOf(true, 30_000L, null), 20_000L, "HB")
        check("unknown duration still advances (nothing to clamp against)", s.positionMs == 50_000L)
    }
    run {
        val s = PositionReanchor.reanchor(stateOf(true, 30_000L), 0L, "HB")
        check("zero elapsed delta leaves position unchanged", s.positionMs == 30_000L)
    }
    run {
        val s = PositionReanchor.reanchor(stateOf(true, 30_000L), -5_000L, "HB")
        check("negative delta never runs position backwards", s.positionMs == 30_000L)
    }

    // ---- Phase 1B-2: browser-safe artwork ----
    check("artwork: https passes through", ArtworkPolicy.browserSafeArtwork("https://i.scdn.co/x.jpg") == "https://i.scdn.co/x.jpg")
    check("artwork: http passes through", ArtworkPolicy.browserSafeArtwork("http://example.com/a.png") == "http://example.com/a.png")
    check("artwork: content:// becomes null (Spotify Android real-device case)", ArtworkPolicy.browserSafeArtwork("content://media/album/12") == null)
    check("artwork: null stays null (ordinary YouTube real-device case)", ArtworkPolicy.browserSafeArtwork(null) == null)
    check("artwork: file:// becomes null", ArtworkPolicy.browserSafeArtwork("file:///sdcard/a.jpg") == null)
    check("artwork: scheme matching is case-insensitive", ArtworkPolicy.browserSafeArtwork("HTTPS://x.com/a.jpg") == "HTTPS://x.com/a.jpg")


    // ---- keepalive lifecycle (pure state machine) ----
    run {
        var s = KeepaliveLifecycle.State()
        check("keepalive: not running before the listener connects", !s.keepaliveRunning)

        s = KeepaliveLifecycle.next(s, KeepaliveLifecycle.Event.LISTENER_CONNECTED)
        check("keepalive: running once the listener connects", s.keepaliveRunning)

        for (e in listOf(KeepaliveLifecycle.Event.PLAYBACK_STARTED, KeepaliveLifecycle.Event.PLAYBACK_PAUSED,
                         KeepaliveLifecycle.Event.SELECTION_BECAME_NULL, KeepaliveLifecycle.Event.TRACK_CHANGED,
                         KeepaliveLifecycle.Event.SOURCE_SWITCHED)) {
            s = KeepaliveLifecycle.next(s, e)
            check("keepalive: stays running through $e (NOT tied to playback state)", s.keepaliveRunning)
        }

        s = KeepaliveLifecycle.next(s, KeepaliveLifecycle.Event.LISTENER_CONNECTED)
        check("keepalive: reconnect is idempotent (still exactly running)", s.keepaliveRunning)

        s = KeepaliveLifecycle.next(s, KeepaliveLifecycle.Event.LISTENER_DISCONNECTED)
        check("keepalive: stops when the listener disconnects", !s.keepaliveRunning)

        s = KeepaliveLifecycle.next(s, KeepaliveLifecycle.Event.DESTROYED)
        check("keepalive: destroy after disconnect is idempotent", !s.keepaliveRunning)

        s = KeepaliveLifecycle.next(KeepaliveLifecycle.State(listenerConnected = true), KeepaliveLifecycle.Event.DESTROYED)
        check("keepalive: destroy without a prior disconnect still stops it (out-of-order safe)",
            !s.keepaliveRunning)
    }


    run {
        val snap = snapshot("com.spotify.music", RawPlaybackState.PLAYING)
            .copy(artUri = "https://img/small.jpg", albumArtUri = "https://img/album.jpg")
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        check("albumArtUri still preferred over artUri when both are browser-safe",
            state.artwork == "https://img/album.jpg")
    }
    run {
        val snap = snapshot("com.spotify.music", RawPlaybackState.PLAYING)
            .copy(artUri = "https://img/small.jpg", albumArtUri = null)
        val state = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 200_000L)
        check("artUri used when albumArtUri absent (browser-safe)", state.artwork == "https://img/small.jpg")
    }

    // ================= Phase 1C.1: YouTube metadata resolver =================
    // (1) uploader is NOT the musical artist
    run {
        val r = YouTubeMetadataResolver.resolve(
            "Rock & Roll Hall of Fame",
            "2021 Remaster \"While My Guitar Gently Weeps\" Prince, Tom Petty & More | Rock Hall 2004 Induction",
            null)
        check("REQUIRED(1): uploader 'Rock & Roll Hall of Fame' does NOT become the artist", r.artist == null)
        check("REQUIRED(1): artist is explicitly non-canonical", !r.artistIsCanonical)
        check("REQUIRED(1): provenance records it was only an uploader", r.artistProvenance == Provenance.YOUTUBE_UPLOADER)
        check("REQUIRED(1): the track is still populated", !r.track.isNullOrBlank())
    }
    // (2) strong title parse
    run {
        val r = YouTubeMetadataResolver.resolve("Gorillaz", "Gorillaz - Feel Good Inc. (Official Video)", null)
        check("REQUIRED(2): artist = Gorillaz", r.artist == "Gorillaz")
        check("REQUIRED(2): track = Feel Good Inc.", r.track == "Feel Good Inc.")
        check("REQUIRED(2): marked canonical", r.artistIsCanonical)
    }
    run {
        // Same title, but uploader does NOT match: the official-marker
        // convention is still strong enough on its own.
        val r = YouTubeMetadataResolver.resolve("SomeMusicChannel", "Gorillaz - Feel Good Inc. (Official Video)", null)
        check("REQUIRED(2): title convention alone resolves artist = Gorillaz", r.artist == "Gorillaz")
        check("REQUIRED(2): provenance is title parse", r.artistProvenance == Provenance.YOUTUBE_TITLE_PARSE)
    }
    // (3) Topic channel
    run {
        val r = YouTubeMetadataResolver.resolve("Gorillaz - Topic", "Feel Good Inc.", null)
        check("REQUIRED(3): Topic channel gives strong artist evidence", r.artist == "Gorillaz")
        check("REQUIRED(3): provenance is topic channel", r.artistProvenance == Provenance.YOUTUBE_TOPIC_CHANNEL)
        check("REQUIRED(3): marked canonical", r.artistIsCanonical)
    }
    // (5) ambiguous stays unresolved
    run {
        val r = YouTubeMetadataResolver.resolve("Some Channel", "Live 1982 - Full Concert", null)
        check("REQUIRED(5): a lone hyphen with no official marker stays unresolved", r.artist == null)
    }
    run {
        val r = YouTubeMetadataResolver.resolve("Some Channel", "Just A Video Title", null)
        check("REQUIRED(5): a title with no separator stays unresolved", r.artist == null)
    }
    run {
        val r = YouTubeMetadataResolver.resolve(null, "Something - Else (Official Video)", null)
        check("no uploader at all still resolves via the title convention", r.artist == "Something")
    }
    run {
        val r = YouTubeMetadataResolver.resolve("Chan", "2021 - Best Of | Mix (Official Video)", null)
        check("implausible artist candidate (contains a pipe) stays unresolved", r.artist == null)
    }
    // Existing real-device behaviour preserved
    run {
        val r = YouTubeMetadataResolver.resolve("Judas Priest", "Judas Priest - The Sentinel (Official Audio)", null)
        check("PRESERVED: real-device Judas Priest case still resolves correctly",
            r.artist == "Judas Priest" && r.track == "The Sentinel")
    }
    run {
        val r = YouTubeMetadataResolver.resolve("SomeChannel", "My reaction to official video - Gorillaz", null)
        check("REGRESSION: words 'official video' in the middle do NOT canonicalize the left side",
            r.artist == null && !r.artistIsCanonical)
    }
    run {
        val r = YouTubeMetadataResolver.resolve("Judas Priest", "Judas Priest – The Sentinel - 2021", null)
        check("REGRESSION: uploader prefix works with mixed separator types",
            r.artist == "Judas Priest" && r.track == "The Sentinel - 2021")
    }
    run {
        val r = YouTubeMetadataResolver.resolve("Radio Nova", "Ezechiel Pailhes - Éternel été | Live Plus Près De Toi", null)
        check("REAL DEVICE: Radio Nova is not artist; title resolves Ezechiel Pailhes",
            r.artist == "Ezechiel Pailhes" && r.track == "Éternel été | Live Plus Près De Toi")
        check("REAL DEVICE: raw Radio Nova uploader provenance is retained",
            r.uploaderCandidate == "Radio Nova")
    }
    run {
        val r = YouTubeMetadataResolver.resolve("Some Channel", "Live 1982 - Full Concert", null)
        check("REGRESSION: generic exact-title rule still rejects Live 1982 descriptor", r.artist == null)
    }

    // ================= (4) Spotify metadata unchanged =================
    run {
        val snap = snapshot("com.spotify.music", RawPlaybackState.PLAYING,
            artist = "Dream Theater", track = "Space-Dye Vest",
            durationMsRaw = 449_000L, positionRaw = 178_961L, lastPositionUpdateTimeMs = 100_000L)
        val st = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 100_000L)
        check("REQUIRED(4): Spotify artist untouched", st.artist == "Dream Theater")
        check("REQUIRED(4): Spotify track untouched", st.track == "Space-Dye Vest")
    }
    // End-to-end: the Rock Hall case through StateNormalizer
    run {
        val snap = snapshot("com.google.android.youtube", RawPlaybackState.PLAYING,
            artist = "Rock & Roll Hall of Fame",
            track = "2021 Remaster \"While My Guitar Gently Weeps\" Prince, Tom Petty & More | Rock Hall 2004 Induction",
            durationMsRaw = 300_000L, positionRaw = 1_000L, lastPositionUpdateTimeMs = 100_000L)
        val st = StateNormalizer.normalize(snap, "2026-01-01T00:00:00.000Z", 100_000L)
        check("end-to-end: uploader never reaches CurrentListeningState.artist", st.artist == null)
        check("end-to-end: primaryArtist matches artist", st.primaryArtist == null)
    }

    // ================= (6,7) artwork =================
    run {
        val a = ArtworkResolver.resolve("youtube_android", "https://i.ytimg.com/vi/abc/hq.jpg", null, false)
        check("REQUIRED(6): a valid https artwork URI is preserved",
            a.url == "https://i.ytimg.com/vi/abc/hq.jpg" && a.kind == ArtworkKind.SOURCE_URI)
    }
    run {
        val a = ArtworkResolver.resolve("youtube_android", "content://media/album/1", null, true)
        check("REQUIRED(7): a bitmap is NOT serialized into state; content:// yields no URL",
            a.url == null && a.kind == ArtworkKind.NONE)
    }
    run {
        val a = ArtworkResolver.resolve("youtube_android", null,
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ", false)
        check("verified YouTube URL yields a thumbnail",
            a.url == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" && a.kind == ArtworkKind.VIDEO_THUMBNAIL)
        check("thumbnail is marked as a VIDEO thumbnail, not canonical album art",
            a.kind != ArtworkKind.CANONICAL_ALBUM_ART)
    }
    run {
        check("youtu.be short URL is verified", ArtworkResolver.verifiedYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ")
        check("music.youtube.com watch URL is verified", ArtworkResolver.verifiedYouTubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ")
        check("youtube shorts URL is verified", ArtworkResolver.verifiedYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ")
        check("a bare ID-shaped media id is NOT accepted as verification",
            ArtworkResolver.verifiedYouTubeVideoId("dQw4w9WgXcQ") == null)
        check("a non-YouTube URL is not accepted",
            ArtworkResolver.verifiedYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ") == null)
        check("spotify source never gets a YouTube thumbnail",
            ArtworkResolver.resolve("spotify_android", null, "https://youtu.be/dQw4w9WgXcQ", false).url == null)
    }

    // ================= (10) keepalive unaffected by playback =================
    // (covered by the KeepaliveLifecycle state machine tests above)

    // ================= Phase 2A: ambient recognition core =================
    check("ambient timecode MM:SS parses", AmbientTimecode.parseMs("02:32") == 152_000L)
    check("ambient timecode HH:MM:SS parses", AmbientTimecode.parseMs("01:02:03") == 3_723_000L)
    check("ambient malformed timecode rejected", AmbientTimecode.parseMs("01:99") == null)

    // ---- Phase 3 Shazam/SongRec fingerprint packet ----
    run {
        val samples = ShortArray(3 * 16_000) { i ->
            val t = i.toDouble() / 16_000.0
            val value =
                0.36 * sin(2.0 * PI * 440.0 * t) +
                0.23 * sin(2.0 * PI * 987.0 * t) +
                0.16 * sin(2.0 * PI * 2130.0 * t) +
                0.09 * sin(2.0 * PI * (300.0 + 300.0 * t) * t)
            (value * 32767.0).toInt().coerceIn(-32768, 32767).toShort()
        }
        val prefix = "data:audio/vnd.shazam.sig;base64,"
        val encoded1 = ShazamFingerprint.encodeSamples(samples)
        val encoded2 = ShazamFingerprint.encodeSamples(samples)
        check("phase3 fingerprint: deterministic for identical PCM", encoded1 == encoded2)
        check("phase3 fingerprint: has Shazam data URI prefix", encoded1.startsWith(prefix))
        val packet = Base64.getDecoder().decode(encoded1.removePrefix(prefix))
        fun u32(offset: Int): Long =
            (packet[offset].toLong() and 0xffL) or
                ((packet[offset + 1].toLong() and 0xffL) shl 8) or
                ((packet[offset + 2].toLong() and 0xffL) shl 16) or
                ((packet[offset + 3].toLong() and 0xffL) shl 24)
        check("phase3 fingerprint: packet contains peak payload", packet.size > 56)
        check("phase3 fingerprint: Shazam header magic valid", u32(0) == 0xcafe2580L && u32(12) == 0x94119c00L)
        check("phase3 fingerprint: packet declares 16 kHz", u32(28) == (3L shl 27))
        val crc = CRC32().apply { update(packet, 8, packet.size - 8) }.value
        check("phase3 fingerprint: CRC32 matches payload", u32(4) == crc)
    }
    check("ambient response anchor advances capture plus network age",
        AmbientPositionAnchor.atResponse(105_000L, 9_250L, 257_000L) == 114_250L)
    check("ambient response anchor clamps to duration",
        AmbientPositionAnchor.atResponse(250_000L, 12_000L, 257_000L) == 257_000L)
    check("ambient response anchor preserves unknown",
        AmbientPositionAnchor.atResponse(null, 9_000L, 257_000L) == null)
    check("ambient response anchor ignores negative elapsed",
        AmbientPositionAnchor.atResponse(105_000L, -500L, 257_000L) == 105_000L)
    val silentPcm = ByteArray(8_820)
    val silentStats = com.listeningmirror.companion.logic.Pcm16SignalAnalyzer.analyze(silentPcm)
    check("ambient PCM silence rejected", !silentStats.isUsable(-55.0, -42.0))
    val loudPcm = ByteArray(8_820)
    var loudIndex = 0
    var loudSign = 1
    while (loudIndex + 1 < loudPcm.size) {
        val sample = 8_000 * loudSign
        loudPcm[loudIndex] = (sample and 0xff).toByte()
        loudPcm[loudIndex + 1] = ((sample shr 8) and 0xff).toByte()
        loudSign = -loudSign
        loudIndex += 2
    }
    val loudStats = com.listeningmirror.companion.logic.Pcm16SignalAnalyzer.analyze(loudPcm)
    check("ambient PCM audible signal accepted", loudStats.isUsable(-55.0, -42.0))

    run {
        fun st(source: String, playing: Boolean) = CurrentListeningState(
            source = source, artist = "Artist", primaryArtist = "Artist", track = "Track",
            album = null, artwork = null, isPlaying = playing, durationMs = 200_000L,
            positionMs = 10_000L, externalId = source, externalUrl = null, confidence = null,
            capturedAt = "2026-01-01T00:00:00.000Z", controlsSupported = false,
        )
        val playingMedia = st("youtube_android", true)
        val pausedMedia = st("spotify_android", false)
        val ambient = st("ambient_audd", true)
        check("ambient arbitration: active device playback wins",
            AmbientSourceSelector.choose(playingMedia, ambient) == playingMedia)
        check("ambient arbitration: ambient wins over paused device session",
            AmbientSourceSelector.choose(pausedMedia, ambient) == ambient)
        check("ambient arbitration: paused device state remains without ambient",
            AmbientSourceSelector.choose(pausedMedia, null) == pausedMedia)
        check("ambient arbitration: ambient works with no media session",
            AmbientSourceSelector.choose(null, ambient) == ambient)
    }

    // ---- static manifest / architecture assertions ----
    ManifestChecks.run { label, ok -> check(label, ok) }

    println("\n$pass passed, $fail failed")
    if (fail > 0) kotlin.system.exitProcess(1)
}
