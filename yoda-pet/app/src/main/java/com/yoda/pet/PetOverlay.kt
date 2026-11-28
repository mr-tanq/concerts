package com.yoda.pet

import android.annotation.SuppressLint
import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.Choreographer
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.yoda.pet.logic.Perimeter
import kotlin.math.PI
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

/**
 * Yoda himself: a small window that walks around the edges of the screen
 * on top of other apps (or just along the bottom), can be picked up and
 * dropped with a finger, plus a speech-bubble window that floats next to him.
 */
class PetOverlay(private val ctx: Context) {

    private enum class Mode { WALK, STAND, SIT, SLEEP, JUMP, TALK, DRAG }

    private val wm = ctx.getSystemService(WindowManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val prefs = Prefs(ctx)
    private val spotify = SpotifyClient(ctx)
    private val density = ctx.resources.displayMetrics.density
    private fun dp(v: Float) = (v * density).roundToInt()
    private fun dp(v: Int) = dp(v.toFloat())

    // All sprites share one scale: walk frames are 260 px tall in the source art.
    private val scale = dp(prefs.petSizeDp) / 260f
    // Square window: the same box fits every edge, so corners join up without a jump
    // and he can turn smoothly in place.
    private val winW = (300 * scale).roundToInt()
    private val winH = winW
    private val jumpHeight = dp(prefs.petSizeDp * 0.9f)
    private val speed = dp(prefs.petSizeDp * 0.42f).toFloat() // px per second
    private val touchSlop = ViewConfiguration.get(ctx).scaledTouchSlop

    /** yoda_walk_1 … yoda_walk_N — however many frames the art has (4, 8, 12 …). */
    @SuppressLint("DiscouragedApi")
    private val walkFrames: IntArray = generateSequence(1) { it + 1 }
        .map { ctx.resources.getIdentifier("yoda_walk_$it", "drawable", ctx.packageName) }
        .takeWhile { it != 0 }
        .toList().toIntArray()
    /** Distance covered by one full walk cycle, so feet don't slide. */
    private val strideLength = winW * 1.0f // one full 8-frame gait cycle
    private var walked = 0f
    private val choreographer = Choreographer.getInstance()
    private val drawables = HashMap<Int, Drawable>()

    /** Draws the current sprite, turned so his feet face the edge he walks on. */
    private inner class PetView : View(ctx) {
        var sprite: Drawable? = null
        var rotationDeg = 0f
        var flip = false

        override fun onDraw(c: Canvas) {
            val d = sprite ?: return
            val dw = d.intrinsicWidth * scale
            val dh = d.intrinsicHeight * scale
            c.save()
            c.translate(width / 2f, height / 2f)
            c.rotate(rotationDeg)
            if (flip) c.scale(-1f, 1f)
            // In the art's own frame the window is winW x winH; feet on its bottom line.
            d.setBounds((-dw / 2).roundToInt(), (winH / 2f - dh).roundToInt(), (dw / 2).roundToInt(), (winH / 2f).roundToInt())
            d.draw(c)
            c.restore()
        }
    }

    private val root = PetView()
    private val petParams = WindowManager.LayoutParams(
        winW, winH,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        title = "Yoda"
        if (Build.VERSION.SDK_INT >= 30) fitInsetsTypes = WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
    }

    private var attached = false
    private var running = false
    private var mode = Mode.WALK
    private var modeUntil = 0L
    private var pos = 0f              // position along the path
    private var dir = 1               // +1 counter-clockwise (right along the bottom), -1 the other way
    private var pose: Perimeter.Pose? = null
    private var targetRotation = 0f
    private var lastFrameNanos = 0L
    private var jumpStart = 0L
    private var lastInteraction = SystemClock.uptimeMillis()

    // Dragging
    private var dragging = false
    private var downX = 0f
    private var downY = 0f
    private var frameOffX = 0
    private var frameOffY = 0
    private var dragX = 0f
    private var dragY = 0f

    // Speech bubble
    private var bubble: View? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var bubbleDismissOnOutside = true
    private val hideBubble = Runnable { dismissBubble() }

    init {
        attachGestures()
    }

    // ---------------------------------------------------------------- lifecycle

    fun show() {
        if (attached) return
        pos = Random.nextFloat() * (areaWidth() - winW).coerceAtLeast(1) // start somewhere on the bottom
        applyPose(path().pose(pos), 0, 0)
        wm.addView(root, petParams)
        attached = true
        setMode(Mode.WALK)
        resume()
        PetBus.overlay = this
        main.postDelayed({ say("Woof! I'm Yoda 🐾", "Tap: what's playing · Double-tap: a favourite song · Hold: settings · Drag me anywhere", autoHideMs = 6000) }, 800)
    }

    fun hide() {
        pause()
        dismissBubble()
        if (attached) runCatching { wm.removeView(root) }
        attached = false
        if (PetBus.overlay === this) PetBus.overlay = null
    }

    fun pause() {
        running = false
        choreographer.removeFrameCallback(frame)
    }

    fun resume() {
        if (!attached || running) return
        running = true
        lastFrameNanos = 0L
        choreographer.postFrameCallback(frame)
    }

    fun onScreenSizeChanged() {
        pos = path().normalize(pos)
        positionBubble()
    }

    // ---------------------------------------------------------------- geometry

    /** The overlay frame: the screen minus status/navigation bars and camera cutout. */
    private fun areaWidth(): Int = areaSize().first
    private fun areaHeight(): Int = areaSize().second

    private fun areaSize(): Pair<Int, Int> {
        if (Build.VERSION.SDK_INT >= 30) {
            val m = wm.currentWindowMetrics
            val i = m.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            return (m.bounds.width() - i.left - i.right) to (m.bounds.height() - i.top - i.bottom)
        }
        val dm = ctx.resources.displayMetrics
        val sbId = ctx.resources.getIdentifier("status_bar_height", "dimen", "android")
        val sb = if (sbId > 0) ctx.resources.getDimensionPixelSize(sbId) else 0
        return dm.widthPixels to (dm.heightPixels - sb)
    }

    private fun path(): Perimeter {
        val (w, h) = areaSize()
        return Perimeter(w, h, winW, winH, prefs.wholeScreen)
    }

    private fun applyPose(p: Perimeter.Pose, offX: Int, offY: Int) {
        val sizeChanged = petParams.width != p.winW || petParams.height != p.winH
        val nx = p.x + offX
        val ny = p.y + offY
        if (sizeChanged || nx != petParams.x || ny != petParams.y) {
            petParams.width = p.winW
            petParams.height = p.winH
            petParams.x = nx
            petParams.y = ny
            if (attached) wm.updateViewLayout(root, petParams)
        }
        targetRotation = p.rotation.toFloat()
        pose = p
    }

    // ---------------------------------------------------------------- animation

    /** Runs once per screen refresh (60/90/120 Hz), so movement stays smooth. */
    private val frame = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!running) return
            val dt = if (lastFrameNanos == 0L) 0f else ((frameTimeNanos - lastFrameNanos) / 1e9f).coerceIn(0f, 0.1f)
            lastFrameNanos = frameTimeNanos
            step(dt)
            choreographer.postFrameCallback(this)
        }
    }

    private fun step(dt: Float) {
        val now = SystemClock.uptimeMillis()
        if (mode == Mode.DRAG) return

        val path = path()
        var offX = 0
        var offY = 0

        when (mode) {
            Mode.WALK -> {
                pos += dir * speed * dt
                walked += speed * dt
                if (!path.wholeScreen) {
                    if (pos <= 0f) { pos = 0f; dir = 1 }
                    if (pos >= path.length) { pos = path.length; dir = -1 }
                }
                val n = walkFrames.size
                val i = (((walked % strideLength) / strideLength) * n).toInt().coerceIn(0, n - 1)
                setSprite(walkFrames[i], flip = dir < 0)
            }
            Mode.STAND, Mode.TALK -> setSprite(R.drawable.yoda_stand, false)
            Mode.SIT -> setSprite(R.drawable.yoda_sit, false)
            Mode.SLEEP -> setSprite(R.drawable.yoda_sleep, false)
            Mode.JUMP -> {
                val t = (now - jumpStart) / 700f
                if (t >= 1f) {
                    setMode(if (bubble != null) Mode.TALK else Mode.WALK)
                } else {
                    val edge = path.pose(pos).edge
                    val (jx, jy) = Perimeter.jumpOffset(edge, (sin(PI * t) * jumpHeight).roundToInt())
                    offX = jx; offY = jy
                    // The jump art leaps toward the left.
                    setSprite(R.drawable.yoda_jump, flip = dir > 0)
                }
            }
            Mode.DRAG -> Unit
        }
        pos = path.normalize(pos)

        if (mode != Mode.TALK && mode != Mode.JUMP && now >= modeUntil) nextMode()
        applyPose(path.pose(pos), offX, offY)
        turnTowardTarget(dt)
    }

    /** Turn gradually (about a fifth of a second per corner) instead of snapping. */
    private fun turnTowardTarget(dt: Float) {
        var delta = (targetRotation - root.rotationDeg) % 360f
        if (delta > 180f) delta -= 360f
        if (delta < -180f) delta += 360f
        if (delta == 0f) return
        val maxStep = 450f * dt
        root.rotationDeg = if (kotlin.math.abs(delta) <= maxStep) targetRotation else root.rotationDeg + kotlin.math.sign(delta) * maxStep
        root.invalidate()
    }

    private fun nextMode() {
        val idleFor = SystemClock.uptimeMillis() - lastInteraction
        when (mode) {
            Mode.WALK -> setMode(if (Random.nextFloat() < 0.6f) Mode.STAND else Mode.SIT)
            Mode.STAND, Mode.SIT -> when {
                idleFor > 3 * 60_000 && Random.nextFloat() < 0.35f -> setMode(Mode.SLEEP)
                else -> {
                    if (Random.nextFloat() < 0.35f) dir = -dir
                    setMode(Mode.WALK)
                }
            }
            Mode.SLEEP -> setMode(Mode.SIT)
            else -> setMode(Mode.WALK)
        }
    }

    private fun setMode(m: Mode) {
        mode = m
        val now = SystemClock.uptimeMillis()
        modeUntil = now + when (m) {
            Mode.WALK -> Random.nextLong(6_000, 14_000)
            Mode.STAND -> Random.nextLong(2_500, 5_000)
            Mode.SIT -> Random.nextLong(4_000, 8_000)
            Mode.SLEEP -> Random.nextLong(30_000, 90_000)
            Mode.JUMP, Mode.TALK, Mode.DRAG -> Long.MAX_VALUE
        }
        if (m == Mode.JUMP) jumpStart = now
    }

    private fun setSprite(id: Int, flip: Boolean) {
        val d = drawables.getOrPut(id) { ctx.getDrawable(id)!! }
        if (root.sprite !== d || root.flip != flip) {
            root.sprite = d
            root.flip = flip
            root.invalidate()
        }
    }

    private fun jump() {
        if (mode != Mode.JUMP && mode != Mode.DRAG) setMode(Mode.JUMP)
    }

    private fun screenWidth(): Int = areaWidth()

    // ---------------------------------------------------------------- touch

    @SuppressLint("ClickableViewAccessibility")
    private fun attachGestures() {
        val detector = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true
            override fun onSingleTapConfirmed(e: MotionEvent): Boolean { onTap(); return true }
            override fun onDoubleTap(e: MotionEvent): Boolean { onDoubleTap(); return true }
            override fun onLongPress(e: MotionEvent) { if (!dragging) onLongPress() }
        })
        root.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = e.rawX; downY = e.rawY; dragging = false }
                MotionEvent.ACTION_MOVE -> if (!dragging && hypot(e.rawX - downX, e.rawY - downY) > touchSlop) {
                    dragging = true
                    val cancel = MotionEvent.obtain(e).apply { action = MotionEvent.ACTION_CANCEL }
                    detector.onTouchEvent(cancel)
                    cancel.recycle()
                    startDrag()
                }
            }
            if (dragging) {
                when (e.actionMasked) {
                    MotionEvent.ACTION_MOVE -> moveDrag(e.rawX, e.rawY)
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { endDrag(e.rawX, e.rawY); dragging = false }
                }
            } else {
                detector.onTouchEvent(e)
            }
            true
        }
    }

    private fun startDrag() {
        lastInteraction = SystemClock.uptimeMillis()
        dismissBubble()
        // Calibrate screen (raw) coordinates against the overlay frame.
        val loc = IntArray(2)
        root.getLocationOnScreen(loc)
        frameOffX = loc[0] - petParams.x
        frameOffY = loc[1] - petParams.y
        setMode(Mode.DRAG)
        root.rotationDeg = 0f
        targetRotation = 0f
        setSprite(R.drawable.yoda_jump, flip = false)
        moveDrag(downX, downY)
    }

    private fun moveDrag(rawX: Float, rawY: Float) {
        val (aw, ah) = areaSize()
        dragX = (rawX - frameOffX).coerceIn(0f, aw.toFloat())
        dragY = (rawY - frameOffY).coerceIn(0f, ah.toFloat())
        petParams.width = winW
        petParams.height = winH
        petParams.x = (dragX - winW / 2f).roundToInt().coerceIn(0, (aw - winW).coerceAtLeast(0))
        petParams.y = (dragY - winH / 2f).roundToInt().coerceIn(0, (ah - winH).coerceAtLeast(0))
        if (attached) wm.updateViewLayout(root, petParams)
        root.invalidate()
    }

    private fun endDrag(rawX: Float, rawY: Float) {
        moveDrag(rawX, rawY)
        val path = path()
        pos = path.nearest(dragX, dragY)
        // Land and look around for a moment, then carry on walking.
        setMode(Mode.STAND)
        setSprite(R.drawable.yoda_stand, false)
        applyPose(path.pose(pos), 0, 0)
    }

    /** Tap: say what's playing right now. */
    private fun onTap() {
        lastInteraction = SystemClock.uptimeMillis()
        if (mode == Mode.SLEEP) setMode(Mode.STAND)
        val local = NowPlaying.onThisPhone(ctx)
        if (local != null && local.playing) { showSong(local); return }
        if (!spotify.isConnected) {
            if (local != null) showSong(local) else nothingPlaying()
            return
        }
        spotify.currentlyPlaying { result ->
            main.post {
                val remote = result.getOrNull()
                when {
                    remote != null && remote.playing -> showSong(remote)
                    local != null -> showSong(local)
                    remote != null -> showSong(remote)
                    result.isFailure -> say("Ruh-roh 🐶", result.exceptionOrNull()?.message ?: "Couldn't reach Spotify.", autoHideMs = 6000)
                    else -> nothingPlaying()
                }
            }
        }
    }

    private fun showSong(song: NowPlaying.Song) {
        val body = buildString {
            append(song.title)
            song.artist?.let { append("\n").append(it) }
            song.app?.let { append("\n").append(if (song.playing) "on " else "paused · ").append(it) }
        }
        say(if (song.playing) "🎵 Now playing" else "⏸ Paused", body, autoHideMs = 7000)
    }

    private fun nothingPlaying() {
        say("🤫 Nothing playing", "Double-tap me and I'll put on one of your favourites!", autoHideMs = 5000)
    }

    /** Double tap: jump and play a random favourite. */
    private fun onDoubleTap() {
        lastInteraction = SystemClock.uptimeMillis()
        jump()
        if (!spotify.isConnected) {
            say("Woof! 🎵", "Connect Spotify in the Yoda app and I'll play your favourite songs.",
                buttons = listOf("Connect" to { openApp() }, "Later" to {}), autoHideMs = 10_000)
            return
        }
        say("🎵 Fetching a song you love…", null, autoHideMs = 20_000)
        spotify.playRandomFavorite { result ->
            main.post {
                when (result) {
                    is SpotifyClient.PlayResult.Playing ->
                        say("🎵 Now playing", "${result.track.name}\n${result.track.artists}", autoHideMs = 7000)
                    is SpotifyClient.PlayResult.Opened ->
                        say("🎵 One of your favourites", "${result.track.name}\n${result.track.artists}\n(opened in Spotify — press play if it didn't start)", autoHideMs = 8000)
                    is SpotifyClient.PlayResult.Failed ->
                        say("Ruh-roh 🐶", result.message, autoHideMs = 7000)
                }
            }
        }
    }

    private fun onLongPress() {
        lastInteraction = SystemClock.uptimeMillis()
        if (mode == Mode.SLEEP) setMode(Mode.STAND)
        showMenu()
    }

    private fun showMenu() {
        val emailLabel = if (prefs.emailAlerts) "📧 Email alerts: ON" else "📧 Email alerts: OFF"
        val walkLabel = if (prefs.wholeScreen) "🐾 Walk: whole screen" else "🐾 Walk: bottom only"
        say(
            "Yoda 🐾", null,
            buttons = listOf(
                emailLabel to {
                    prefs.emailAlerts = !prefs.emailAlerts
                    say("📧", if (prefs.emailAlerts) "Email alerts are ON. I'll tell you when mail arrives." else "Email alerts are OFF. I'll keep quiet about email.", autoHideMs = 4000)
                },
                walkLabel to {
                    prefs.wholeScreen = !prefs.wholeScreen
                    say("🐾", if (prefs.wholeScreen) "I'll walk around the whole screen." else "I'll stay on the bottom.", autoHideMs = 3500)
                },
                "✕ Close" to {},
            ),
            vertical = true,
            autoHideMs = 15_000,
        )
    }

    // ---------------------------------------------------------------- alerts

    fun announceMeeting(title: String, whenText: String, location: String?, open: () -> Unit) {
        jump()
        val body = buildString {
            append(title)
            append("\n").append(whenText)
            if (!location.isNullOrBlank()) append("\n📍 ").append(location)
        }
        say("📅 Meeting soon!", body,
            buttons = listOf("Open" to open, "Got it" to {}),
            autoHideMs = 90_000, dismissOnOutside = false)
    }

    fun announceEmail(
        sender: String,
        subject: String?,
        contentIntent: PendingIntent?,
        force: Boolean = false,
        account: String? = null,
        count: Int = 1,
        app: String = "com.google.android.gm",
    ) {
        if (!prefs.emailAlerts && !force) return
        jump()
        val title = if (count > 1) "📧 $count new emails — latest from" else "📧 New email from"
        val body = buildString {
            append(sender)
            subject?.let { append("\n“").append(it).append("”") }
            account?.let { append("\n✉️ ").append(it) }
        }
        say(title, body,
            buttons = listOf("Open it" to { openEmail(contentIntent, app) }, "Later" to {}),
            autoHideMs = 30_000, dismissOnOutside = false)
    }

    private fun openEmail(pi: PendingIntent?, app: String) {
        if (pi != null) {
            try {
                val opts = if (Build.VERSION.SDK_INT >= 34) {
                    @Suppress("DEPRECATION")
                    ActivityOptions.makeBasic()
                        .setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                        .toBundle()
                } else null
                pi.send(ctx, 0, null, null, null, null, opts)
                return
            } catch (_: Exception) { /* fall through to opening Gmail */ }
        }
        ctx.packageManager.getLaunchIntentForPackage(app)?.let {
            ctx.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun openApp() {
        ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // ---------------------------------------------------------------- speech bubble

    private val ink = Color.parseColor("#3B2416")
    private val cream = Color.parseColor("#FFF8EF")
    private val brown = Color.parseColor("#6B3A23")

    @SuppressLint("ClickableViewAccessibility")
    fun say(
        title: String,
        body: String?,
        buttons: List<Pair<String, () -> Unit>> = emptyList(),
        vertical: Boolean = false,
        autoHideMs: Long = 8000,
        dismissOnOutside: Boolean = true,
    ) {
        if (!attached) return
        dismissBubble()

        val pad = dp(14)
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dp(12), pad, dp(12))
            background = GradientDrawable().apply {
                setColor(cream)
                cornerRadius = dp(18).toFloat()
                setStroke(dp(2), brown)
            }
            elevation = dp(6).toFloat()
        }
        box.addView(TextView(ctx).apply {
            text = title
            setTextColor(ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.DEFAULT_BOLD
        })
        if (!body.isNullOrBlank()) {
            box.addView(TextView(ctx).apply {
                text = body
                setTextColor(ink)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                setPadding(0, dp(4), 0, 0)
            })
        }
        if (buttons.isNotEmpty()) {
            val row = LinearLayout(ctx).apply {
                orientation = if (vertical) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
                setPadding(0, dp(8), 0, 0)
            }
            buttons.forEachIndexed { i, (label, action) ->
                row.addView(TextView(ctx).apply {
                    text = label
                    setTextColor(Color.WHITE)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                    typeface = Typeface.DEFAULT_BOLD
                    gravity = if (vertical) Gravity.START or Gravity.CENTER_VERTICAL else Gravity.CENTER
                    setPadding(dp(14), dp(9), dp(14), dp(9))
                    background = GradientDrawable().apply { setColor(brown); cornerRadius = dp(14).toFloat() }
                    setOnClickListener {
                        lastInteraction = SystemClock.uptimeMillis()
                        dismissBubble()
                        action()
                    }
                }, LinearLayout.LayoutParams(
                    if (vertical) LinearLayout.LayoutParams.MATCH_PARENT else LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply {
                    if (i > 0) { if (vertical) topMargin = dp(6) else marginStart = dp(8) }
                })
            }
            box.addView(row)
        }
        // Tapping the text (not a button) closes the bubble.
        box.setOnClickListener { dismissBubble() }

        val outer = FrameLayout(ctx).apply {
            setPadding(dp(6), dp(6), dp(6), dp(10))
            addView(box, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))
            setOnTouchListener { _, e ->
                if (e.action == MotionEvent.ACTION_OUTSIDE && bubbleDismissOnOutside) dismissBubble()
                false
            }
        }

        val maxW = (screenWidth() - dp(16)).coerceAtMost(dp(300))
        outer.measure(
            View.MeasureSpec.makeMeasureSpec(maxW, View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
        )
        val params = WindowManager.LayoutParams(
            outer.measuredWidth.coerceAtMost(maxW),
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            setTitle("Yoda bubble")
            if (Build.VERSION.SDK_INT >= 30) fitInsetsTypes = WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
        }
        bubble = outer
        bubbleParams = params
        bubbleDismissOnOutside = dismissOnOutside
        positionBubble()
        wm.addView(outer, params)

        if (mode != Mode.JUMP) setMode(Mode.TALK)
        main.removeCallbacks(hideBubble)
        main.postDelayed(hideBubble, autoHideMs)
    }

    /** Puts the bubble beside Yoda, on the side facing the middle of the screen. */
    private fun positionBubble() {
        val p = bubbleParams ?: return
        val v = bubble ?: return
        val (aw, ah) = areaSize()
        val bw = if (p.width > 0) p.width else v.measuredWidth
        val bh = v.measuredHeight
        val px = petParams.x
        val py = petParams.y
        val pw = petParams.width
        val ph = petParams.height
        val cx = px + pw / 2
        val cy = py + ph / 2
        val gap = dp(2)
        when (pose?.edge ?: Perimeter.Edge.BOTTOM) {
            Perimeter.Edge.BOTTOM -> { p.x = cx - bw / 2; p.y = py - bh + gap }
            Perimeter.Edge.TOP -> { p.x = cx - bw / 2; p.y = py + ph - gap }
            Perimeter.Edge.RIGHT -> { p.x = px - bw + gap; p.y = cy - bh / 2 }
            Perimeter.Edge.LEFT -> { p.x = px + pw - gap; p.y = cy - bh / 2 }
        }
        p.x = p.x.coerceIn(dp(4), (aw - bw - dp(4)).coerceAtLeast(dp(4)))
        p.y = p.y.coerceIn(0, (ah - bh).coerceAtLeast(0))
        if (v.isAttachedToWindow) wm.updateViewLayout(v, p)
    }

    fun dismissBubble() {
        main.removeCallbacks(hideBubble)
        bubble?.let { runCatching { wm.removeView(it) } }
        bubble = null
        bubbleParams = null
        if (mode == Mode.TALK) setMode(Mode.WALK)
    }
}
