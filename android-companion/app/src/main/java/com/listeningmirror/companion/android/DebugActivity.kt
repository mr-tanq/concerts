package com.listeningmirror.companion.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.listeningmirror.companion.ambient.AmbientStatus
import com.listeningmirror.companion.logic.ArtworkResolver
import com.listeningmirror.companion.logic.SourceMapper
import com.listeningmirror.companion.logic.YouTubeMetadataResolver
import com.listeningmirror.companion.model.RawSessionSnapshot

/**
 * The entire prototype UI: a live debug screen. Built with plain views
 * rather than Compose deliberately — fewer dependencies, faster to build,
 * and this screen exists to be read, not to look good.
 *
 * Shows every field from the required debug list, keeping RAW Android
 * values next to NORMALIZED results side by side, because the point of
 * this phase is observing what Spotify and YouTube actually do on a real
 * phone — not just seeing the final answer.
 */
class DebugActivity : AppCompatActivity() {

    private lateinit var permissionSection: LinearLayout
    private lateinit var permissionText: TextView
    private lateinit var grantButton: Button
    private lateinit var selectedContainer: LinearLayout
    private lateinit var allSessionsContainer: LinearLayout
    private lateinit var ambientStatusText: TextView
    private lateinit var ambientToggleButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = ScrollView(this)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 48)
        }
        root.addView(column)

        column.addView(heading("LISTENING MIRROR · COMPANION"))

        permissionSection = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        permissionText = body("")
        grantButton = Button(this).apply {
            text = "Open Notification Access settings"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
        }
        permissionSection.addView(permissionText)
        permissionSection.addView(grantButton)
        column.addView(permissionSection)

        column.addView(Button(this).apply {
            text = "Relay transport settings"
            setOnClickListener { startActivity(android.content.Intent(this@DebugActivity, RelaySettingsActivity::class.java)) }
        })

        column.addView(heading("AMBIENT RECOGNITION"))
        column.addView(body(
            "Start it once and it keeps listening while this screen is closed. " +
                "After microphone permission is granted, you can also start ambient recognition " +
                "from the ongoing Listening Mirror notification and stop it from the ambient notification."
        ))
        ambientStatusText = body("").apply { setPadding(0, 16, 0, 0) }
        column.addView(ambientStatusText)
        ambientToggleButton = Button(this).apply {
            text = "Start ambient recognition"
            setOnClickListener { toggleAmbientRecognition() }
        }
        column.addView(ambientToggleButton)
        column.addView(body(
            "Phase 3 provider: free Shazam/SongRec fingerprinting. " +
                "No Apple Developer account, AudD request, or paid API is used automatically."
        ))
        column.addView(Button(this).apply {
            text = "Legacy AudD settings (manual rollback only)"
            setOnClickListener { startActivity(Intent(this@DebugActivity, AmbientSettingsActivity::class.java)) }
        })

        column.addView(heading("CONCERT DAY"))
        column.addView(body(
            "On the day of a concert you have a ticket for, a reminder comes at 09:00 " +
                "with doors, set times and the room. Runs while playback detection is active."
        ))
        val reminderStatus = body("")
        column.addView(Button(this).apply {
            text = "Send a test reminder"
            setOnClickListener {
                isEnabled = false
                reminderStatus.text = "Reading your concerts…"
                Thread {
                    val message = ConcertReminders.postTest(applicationContext)
                    runOnUiThread {
                        reminderStatus.text = message
                        isEnabled = true
                    }
                }.start()
            }
        })
        column.addView(reminderStatus)

        column.addView(heading("SELECTED SESSION"))
        selectedContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(selectedContainer)

        column.addView(heading("ALL VISIBLE MEDIA SESSIONS"))
        allSessionsContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(allSessionsContainer)

        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        // Re-checked on every resume specifically so returning from the
        // system settings screen immediately reflects a fresh grant,
        // without needing the app to be restarted.
        refreshPermissionState()
        AmbientStatus.subscribe { snapshot ->
            runOnUiThread { renderAmbientStatus(snapshot) }
        }
    }

    override fun onPause() {
        super.onPause()
        // UI subscriptions only. Provider/publisher lifetimes remain owned by
        // MediaNotificationListenerService while this Activity is backgrounded.
        ObservationHub.unsubscribe()
        ObservationHub.unsubscribeObservationState()
        KeepaliveStatus.unsubscribe()
        AmbientStatus.unsubscribe()
    }

    private fun refreshPermissionState() {
        val granted = AndroidMediaSessionProvider.hasNotificationAccess(this)
        if (granted) {
            requestNotificationPermissionIfNeeded()
            grantButton.visibility = View.GONE

            // Status is asynchronous: ensureRunning() only REQUESTS the start;
            // the service itself flips ACTIVE after startForeground succeeds.
            KeepaliveStatus.subscribe {
                runOnUiThread { renderPermissionStatus() }
            }

            // Race-free visible-Activity activation path. If the Activity is
            // already visible when NotificationListener connects later,
            // attachProvider() emits true here and retries the FGS immediately
            // from this still-visible Activity. No polling/reopen required.
            ObservationHub.subscribeObservationState { observing ->
                runOnUiThread {
                    if (observing && !KeepaliveStatus.isActive()) {
                        PlaybackRelayForegroundService.ensureRunning(this)
                    }
                    renderPermissionStatus()
                }
            }

            ObservationHub.subscribe { snapshot ->
                runOnUiThread { render(snapshot) }
            }
            renderPermissionStatus()
        } else {
            ObservationHub.unsubscribe()
            ObservationHub.unsubscribeObservationState()
            KeepaliveStatus.unsubscribe()
            permissionText.text =
                "Notification Access: NOT GRANTED\n\n" +
                "This app reads what's playing from Android's media sessions " +
                "(Spotify, YouTube, etc). Android only exposes that to apps " +
                "with Notification Access, which has to be granted manually " +
                "once, in system settings.\n\n" +
                "It does not read the content of your notifications."
            grantButton.visibility = View.VISIBLE
            selectedContainer.removeAllViews()
            allSessionsContainer.removeAllViews()
        }
    }

    private fun renderPermissionStatus() {
        if (!AndroidMediaSessionProvider.hasNotificationAccess(this)) return
        permissionText.text = KeepaliveStatus.describe() + "\n" + if (ObservationHub.isObserving()) {
            "Notification Access: GRANTED\nObservation: RUNNING (continues while this screen is closed)"
        } else {
            "Notification Access: GRANTED\nObservation: starting...\n\n" +
                "The visible screen will automatically retry foreground keepalive " +
                "as soon as the listener finishes connecting."
        }
    }

    /**
     * Android 13+ only. Purely so the foreground-service notification is
     * visible in the shade -- denial must not affect relay behaviour, so
     * there is deliberately no result handling and nothing is gated on it.
     */
    private fun requestNotificationPermissionIfNeeded() {
        if (android.os.Build.VERSION.SDK_INT < 33) return
        val granted = checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (!granted) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
        }
    }

    private fun toggleAmbientRecognition() {
        if (AmbientStatus.isRunning()) {
            AmbientRecognitionService.stop(this)
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_RECORD_AUDIO)
            return
        }
        startAmbientFromVisibleUi()
    }

    private fun startAmbientFromVisibleUi() {
        if (RelayPublisherHolder.get() == null) {
            ambientStatusText.text = "Ambient: cannot start yet — relay publisher is not running. Grant Notification Access first."
            return
        }
        AmbientRecognitionService.startFromVisibleActivity(this)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_RECORD_AUDIO) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                startAmbientFromVisibleUi()
            } else {
                renderAmbientStatus(AmbientStatus.current(), "Microphone permission denied.")
            }
        }
    }

    private fun renderAmbientStatus(snapshot: AmbientStatus.Snapshot, overrideMessage: String? = null) {
        val micGranted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        ambientStatusText.text = buildString {
            if (overrideMessage != null) append(overrideMessage).append("\n")
            append("Ambient: ").append(snapshot.phase).append('\n')
            append("Microphone permission: ").append(if (micGranted) "GRANTED" else "NOT GRANTED").append('\n')
            append("Provider: free Shazam/SongRec\n")
            append("Recognition requests this run: ").append(snapshot.requestCount)
            if (snapshot.lastCaptureDiagnostic != null) append("\nLast capture: ").append(snapshot.lastCaptureDiagnostic)
            if (snapshot.lastMatch != null) append("\nLast match: ").append(snapshot.lastMatch)
            if (snapshot.lastError != null) append("\nLast error: ").append(snapshot.lastError)
        }
        ambientToggleButton.text = if (snapshot.running) "Stop ambient recognition" else "Start ambient recognition"
    }

    private fun render(snapshot: ProviderSnapshot) {
        selectedContainer.removeAllViews()
        val raw = snapshot.selectedRaw
        val state = snapshot.selectedState

        if (raw == null || state == null) {
            selectedContainer.addView(body("(no active device playback)"))
        } else {
            selectedContainer.addView(row("PACKAGE", raw.packageName))
            selectedContainer.addView(row("SOURCE", state.source))
            selectedContainer.addView(row("RAW PLAYBACK STATE", "${raw.rawPlaybackStateInt} (${raw.playbackState})"))

            val youtubeResolved = if (state.source == SourceMapper.SOURCE_YOUTUBE ||
                state.source == SourceMapper.SOURCE_YOUTUBE_MUSIC) {
                YouTubeMetadataResolver.resolve(raw.artist, raw.track, raw.album)
            } else null
            selectedContainer.addView(row("RAW ARTIST / UPLOADER", raw.artist))
            selectedContainer.addView(row("ARTIST", state.artist))
            if (youtubeResolved != null) {
                selectedContainer.addView(row("ARTIST CANDIDATE", youtubeResolved.artistCandidate))
                selectedContainer.addView(row("ARTIST PROVENANCE", youtubeResolved.artistProvenance.name))
                selectedContainer.addView(row("ARTIST CANONICAL?", youtubeResolved.artistIsCanonical.toString()))
            }
            // Raw and normalized side by side: on YouTube these differ,
            // and seeing both is the point of the debug screen.
            selectedContainer.addView(row("TRACK RAW", raw.track))
            selectedContainer.addView(row("TRACK NORMALIZED", state.track))
            selectedContainer.addView(row("ALBUM", state.album))
            selectedContainer.addView(row("MEDIA ID", state.externalId))
            selectedContainer.addView(row("MEDIA URI", state.externalUrl))
            selectedContainer.addView(row("POSITION RAW", raw.positionRaw?.toString()))
            selectedContainer.addView(row("POSITION NORMALIZED", state.positionMs?.toString()))
            selectedContainer.addView(row("LAST POSITION UPDATE TIME", raw.lastPositionUpdateTimeMs?.toString()))
            // Diagnostic only — never feeds normalization in this phase.
            selectedContainer.addView(row("PLAYBACK SPEED", raw.playbackSpeed?.toString()))
            selectedContainer.addView(row("DURATION RAW", raw.durationMsRaw?.toString()))
            selectedContainer.addView(row("DURATION NORMALIZED", state.durationMs?.toString()))
            selectedContainer.addView(row("ART URI", raw.artUri))
            selectedContainer.addView(row("ALBUM ART URI", raw.albumArtUri))
            val resolvedArtwork = ArtworkResolver.resolve(
                source = state.source,
                artworkUri = raw.albumArtUri ?: raw.artUri,
                mediaUri = raw.mediaUri,
                hasBitmap = raw.hasAlbumArtBitmap || raw.hasArtBitmap,
            )
            selectedContainer.addView(row("ARTWORK (normalized)", state.artwork))
            selectedContainer.addView(row("ARTWORK KIND", resolvedArtwork.kind.name))
            selectedContainer.addView(row("ART BITMAP AVAILABLE?", raw.hasArtBitmap.toString()))
            selectedContainer.addView(row("ALBUM ART BITMAP AVAILABLE?", raw.hasAlbumArtBitmap.toString()))
            selectedContainer.addView(row("IS PLAYING", state.isPlaying.toString()))
            selectedContainer.addView(row("METADATA COMPLETE FOR LYRICS?", snapshot.metadataCompleteForLyrics.toString()))
            selectedContainer.addView(row("CONFIDENCE", state.confidence?.toString() ?: "null (by design)"))
            selectedContainer.addView(row("CONTROLS SUPPORTED", state.controlsSupported.toString()))
            selectedContainer.addView(row("CAPTURED AT", state.capturedAt))
        }

        allSessionsContainer.removeAllViews()
        if (snapshot.allSessions.isEmpty()) {
            allSessionsContainer.addView(body("(no media sessions visible)"))
        } else {
            snapshot.allSessions.forEach { session ->
                allSessionsContainer.addView(sessionBlock(session, session.sessionId == snapshot.selectedSessionId))
            }
        }
    }

    private fun sessionBlock(session: RawSessionSnapshot, isSelected: Boolean): View {
        val block = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 20, 0, 20)
        }
        block.addView(body(if (isSelected) "▸ SELECTED" else "  not selected"))
        block.addView(row("  package", session.packageName))
        block.addView(row("  source", SourceMapper.sourceFor(session.packageName)))
        block.addView(row("  raw state", "${session.rawPlaybackStateInt} (${session.playbackState})"))
        block.addView(row("  os priority index", session.osPriorityIndex.toString()))
        block.addView(row("  title", session.track))
        block.addView(row("  artist", session.artist))
        return block
    }

    private fun heading(text: String) = TextView(this).apply {
        this.text = text
        textSize = 13f
        setPadding(0, 44, 0, 16)
        typeface = android.graphics.Typeface.MONOSPACE
    }

    private fun body(text: String) = TextView(this).apply {
        this.text = text
        textSize = 12f
        typeface = android.graphics.Typeface.MONOSPACE
    }

    private fun row(label: String, value: String?) = TextView(this).apply {
        text = "$label: ${value ?: "null"}"
        textSize = 12f
        setPadding(0, 4, 0, 4)
        typeface = android.graphics.Typeface.MONOSPACE
    }

    private companion object {
        const val REQUEST_RECORD_AUDIO = 2001
    }

}
