package com.yoda.pet

import android.annotation.SuppressLint
import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
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
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

/**
 * Yoda himself: a small window that walks along the bottom of the screen on
 * top of other apps, plus a speech-bubble window that floats above him.
 */
class PetOverlay(private val ctx: Context) {

    private enum class Mode { WALK, STAND, SIT, SLEEP, JUMP, TALK }

    private val wm = ctx.getSystemService(WindowManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val prefs = Prefs(ctx)
    private val spotify = SpotifyClient(ctx)
    private val density = ctx.resources.displayMetrics.density
    private fun dp(v: Float) = (v * density).roundToInt()
    private fun dp(v: Int) = dp(v.toFloat())

    // All sprites share one scale: walk frames are 260 px tall in the source art.
    private val scale = dp(prefs.petSizeDp) / 260f
    private val winW = (300 * scale).roundToInt()
    private val winH = (265 * scale).roundToInt()
    private val jumpHeight = dp(prefs.petSizeDp * 0.9f)
    private val speed = dp(prefs.petSizeDp * 0.42f).toFloat() // px per second

    private val walkFrames = intArrayOf(R.drawable.yoda_walk_1, R.drawable.yoda_walk_2, R.drawable.yoda_walk_3, R.drawable.yoda_walk_4)
    private val drawables = HashMap<Int, Drawable>()

    private val root = FrameLayout(ctx)
    private val img = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_XY }
    private val petParams = WindowManager.LayoutParams(
        winW, winH,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.BOTTOM or Gravity.START
        title = "Yoda"
    }

    private var attached = false
    private var running = false
    private var mode = Mode.WALK
    private var modeUntil = 0L
    private var x = 0f
    private var dir = 1
    private var curSprite = 0
    private var curFlip = false
    private var jumpStart = 0L
    private var lastTick = 0L
    private var lastInteraction = SystemClock.uptimeMillis()

    // Speech bubble
    private var bubble: View? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var bubbleDismissOnOutside = true
    private val hideBubble = Runnable { dismissBubble() }

    init {
        root.addView(img)
        attachGestures()
    }

    // ---------------------------------------------------------------- lifecycle

    fun show() {
        if (attached) return
        x = Random.nextInt(0, (screenWidth() - winW).coerceAtLeast(1)).toFloat()
        petParams.x = x.roundToInt()
        wm.addView(root, petParams)
        attached = true
        setMode(Mode.WALK)
        resume()
        PetBus.overlay = this
        main.postDelayed({ say("Woof! I'm Yoda 🐾", "Tap me for a song, hold me for more.", autoHideMs = 6000) }, 800)
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
        main.removeCallbacks(tick)
    }

    fun resume() {
        if (!attached || running) return
        running = true
        lastTick = SystemClock.uptimeMillis()
        main.post(tick)
    }

    fun onScreenSizeChanged() {
        x = x.coerceIn(0f, (screenWidth() - winW).coerceAtLeast(0).toFloat())
        positionBubble()
    }

    // ---------------------------------------------------------------- animation

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            step()
            main.postDelayed(this, 33)
        }
    }

    private fun step() {
        val now = SystemClock.uptimeMillis()
        val dt = (now - lastTick).coerceAtMost(100) / 1000f
        lastTick = now
        val maxX = (screenWidth() - winW).coerceAtLeast(0).toFloat()
        var y = 0

        when (mode) {
            Mode.WALK -> {
                x += dir * speed * dt
                if (x <= 0f) { x = 0f; dir = 1 }
                if (x >= maxX) { x = maxX; dir = -1 }
                setSprite(walkFrames[((now / 150) % 4).toInt()], flip = dir < 0)
            }
            Mode.STAND, Mode.TALK -> setSprite(R.drawable.yoda_stand, false)
            Mode.SIT -> setSprite(R.drawable.yoda_sit, false)
            Mode.SLEEP -> setSprite(R.drawable.yoda_sleep, false)
            Mode.JUMP -> {
                val t = (now - jumpStart) / 700f
                if (t >= 1f) {
                    setMode(if (bubble != null) Mode.TALK else Mode.WALK)
                } else {
                    y = (sin(PI * t) * jumpHeight).roundToInt()
                    x = (x + dir * speed * 1.6f * dt).coerceIn(0f, maxX)
                    // The jump art leaps toward the left.
                    setSprite(R.drawable.yoda_jump, flip = dir > 0)
                }
            }
        }

        if (mode != Mode.TALK && mode != Mode.JUMP && now >= modeUntil) nextMode()

        val nx = x.roundToInt()
        if (nx != petParams.x || y != petParams.y) {
            petParams.x = nx
            petParams.y = y
            if (attached) wm.updateViewLayout(root, petParams)
        }
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
            Mode.WALK -> Random.nextLong(5_000, 12_000)
            Mode.STAND -> Random.nextLong(2_500, 5_000)
            Mode.SIT -> Random.nextLong(4_000, 8_000)
            Mode.SLEEP -> Random.nextLong(30_000, 90_000)
            Mode.JUMP, Mode.TALK -> Long.MAX_VALUE
        }
        if (m == Mode.JUMP) jumpStart = now
    }

    private fun setSprite(id: Int, flip: Boolean) {
        if (id != curSprite) {
            val d = drawables.getOrPut(id) { ctx.getDrawable(id)!! }
            img.setImageDrawable(d)
            img.layoutParams = FrameLayout.LayoutParams(
                (d.intrinsicWidth * scale).roundToInt(),
                (d.intrinsicHeight * scale).roundToInt(),
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
            )
            curSprite = id
        }
        if (flip != curFlip) {
            img.scaleX = if (flip) -1f else 1f
            curFlip = flip
        }
    }

    private fun jump() {
        if (mode != Mode.JUMP) setMode(Mode.JUMP)
    }

    private fun screenWidth(): Int =
        if (Build.VERSION.SDK_INT >= 30) wm.currentWindowMetrics.bounds.width()
        else ctx.resources.displayMetrics.widthPixels

    // ---------------------------------------------------------------- touch

    @SuppressLint("ClickableViewAccessibility")
    private fun attachGestures() {
        val detector = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true
            override fun onSingleTapUp(e: MotionEvent): Boolean { onTap(); return true }
            override fun onLongPress(e: MotionEvent) { onLongPress() }
        })
        root.setOnTouchListener { _, e -> detector.onTouchEvent(e); true }
    }

    private fun onTap() {
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
        say(
            "What do you need? 🐾", null,
            buttons = listOf(
                "💪 Encourage me" to { say("💪", Phrases.pick(Phrases.encourage), autoHideMs = 9000) },
                "😂 Say something funny" to { say("😂", Phrases.pick(Phrases.funny), autoHideMs = 9000) },
                "🤗 Check in on me" to { checkIn() },
                emailLabel to {
                    prefs.emailAlerts = !prefs.emailAlerts
                    say("📧", if (prefs.emailAlerts) "Email alerts are ON. I'll tell you when mail arrives." else "Email alerts are OFF. I'll keep quiet about email.", autoHideMs = 4000)
                },
                "✕ Close" to {},
            ),
            vertical = true,
            autoHideMs = 20_000,
        )
    }

    private fun checkIn() {
        say(
            "🤗", Phrases.pick(Phrases.checkInQuestion),
            buttons = listOf(
                "😊 Good" to { say("🐾", Phrases.pick(Phrases.replyGood), autoHideMs = 8000) },
                "😐 Meh" to { say("🐾", Phrases.pick(Phrases.replyOkay), autoHideMs = 10_000) },
                "😔 Not great" to { say("🤍", Phrases.pick(Phrases.replyRough), autoHideMs = 14_000) },
            ),
            autoHideMs = 30_000,
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

    fun announceEmail(sender: String, subject: String?, contentIntent: PendingIntent?, force: Boolean = false) {
        if (!prefs.emailAlerts && !force) return
        jump()
        say("📧 New email from", sender + (subject?.let { "\n“$it”" } ?: ""),
            buttons = listOf("Open it" to { openEmail(contentIntent) }, "Later" to {}),
            autoHideMs = 30_000, dismissOnOutside = false)
    }

    private fun openEmail(pi: PendingIntent?) {
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
        ctx.packageManager.getLaunchIntentForPackage("com.google.android.gm")?.let {
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
            gravity = Gravity.BOTTOM or Gravity.START
            setTitle("Yoda bubble")
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

    private fun positionBubble() {
        val p = bubbleParams ?: return
        val v = bubble ?: return
        val w = if (p.width > 0) p.width else v.measuredWidth
        p.x = (x.roundToInt() + winW / 2 - w / 2).coerceIn(dp(4), (screenWidth() - w - dp(4)).coerceAtLeast(dp(4)))
        p.y = winH - dp(8)
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
