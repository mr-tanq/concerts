package com.listeningmirror.companion.android

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * The single manual setup step: paste the write secret once.
 *
 * Project URL and anon key are NOT entered here -- they are public client
 * configuration compiled in via RelayConfig, which is what keeps setup to
 * one field.
 */
class RelaySettingsActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var input: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = ScrollView(this)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 48)
        }
        root.addView(column)

        column.addView(TextView(this).apply {
            text = "RELAY TRANSPORT"
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 13f
            setPadding(0, 0, 0, 24)
        })

        column.addView(TextView(this).apply {
            text = "Paste the WRITE secret. It is stored encrypted with an " +
                   "Android Keystore key, outside app backup, and must be " +
                   "re-entered after a reinstall."
            textSize = 12f
            setPadding(0, 0, 0, 20)
        })

        input = EditText(this).apply { hint = "lmw_..." }
        column.addView(input)

        column.addView(Button(this).apply {
            text = "Save secret"
            setOnClickListener {
                val value = input.text.toString().trim()
                if (value.isEmpty()) { refresh("Nothing pasted."); return@setOnClickListener }
                val pub = RelayPublisherHolder.get()
                if (pub == null) {
                    refresh("Publisher not running - grant Notification Access first.")
                } else {
                    pub.saveSecret(value)
                    input.setText("")
                    refresh("Secret saved.")
                }
            }
        })

        column.addView(Button(this).apply {
            text = "Clear secret"
            setOnClickListener {
                RelayPublisherHolder.get()?.clearSecret()
                refresh("Secret cleared.")
            }
        })

        statusText = TextView(this).apply {
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 12f
            setPadding(0, 32, 0, 0)
        }
        column.addView(statusText)

        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        refresh(null)
    }

    private fun refresh(message: String?) {
        val pub = RelayPublisherHolder.get()
        val s = pub?.status()
        statusText.text = buildString {
            if (message != null) append(message).append("\n\n")
            if (s == null) {
                append("Publisher: not running\n")
                append("(the listener service starts it once Notification Access is granted)")
            } else {
                append("Publisher: running\n")
                append("Secret configured: ").append(s.hasSecret).append('\n')
                append("Last attempt:  ").append(s.lastAttemptAt ?: "never").append('\n')
                append("Last success:  ").append(s.lastSuccessAt ?: "never").append('\n')
                append("Consecutive failures: ").append(s.consecutiveFailures).append('\n')
                append("Last result:   ").append(s.lastResult ?: "-")
                if (s.lastRejectionReason != null) {
                    append("\n\nREJECTED BY RELAY: ").append(s.lastRejectionReason)
                    append("\n")
                    when (s.lastRejectionReason) {
                        "invalid_secret" -> append("The write secret is wrong or has been revoked.")
                        "stale_sequence" -> append("An out-of-order publish was correctly ignored.")
                        "active_other_device" -> append("Another install is currently active and fresh.")
                        else -> append("See relay logs.")
                    }
                }
            }
        }
    }
}
