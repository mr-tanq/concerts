package com.listeningmirror.companion.android

import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.listeningmirror.companion.ambient.AmbientTokenStore

class AmbientSettingsActivity : AppCompatActivity() {
    private lateinit var store: AmbientTokenStore
    private lateinit var input: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = AmbientTokenStore(this)
        val root = ScrollView(this)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 48)
        }
        root.addView(column)

        column.addView(TextView(this).apply {
            text = "LEGACY · AudD API (ROLLBACK ONLY)"
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 13f
            setPadding(0, 0, 0, 20)
        })
        column.addView(TextView(this).apply {
            text = "Phase 3 ambient recognition uses free Shazam/SongRec and does not call AudD automatically. " +
                "This screen only keeps the old AudD credential available for a future manual rollback.\n\n" +
                "Your token is encrypted with Android Keystore and is never sent to the Listening Mirror relay."
            textSize = 12f
            setPadding(0, 0, 0, 20)
        })

        input = EditText(this).apply {
            hint = "AudD API token"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        column.addView(input)
        column.addView(Button(this).apply {
            text = "Save AudD token"
            setOnClickListener {
                val value = input.text.toString().trim()
                if (value.isBlank()) {
                    refresh("Nothing pasted.")
                } else {
                    store.save(value)
                    input.setText("")
                    refresh("AudD token saved.")
                }
            }
        })
        column.addView(Button(this).apply {
            text = "Clear legacy AudD token"
            setOnClickListener {
                store.clear()
                input.setText("")
                refresh("Saved token cleared.")
            }
        })
        status = TextView(this).apply {
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 12f
            setPadding(0, 28, 0, 0)
        }
        column.addView(status)
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        refresh(null)
    }

    private fun refresh(message: String?) {
        status.text = buildString {
            if (message != null) append(message).append("\n\n")
            if (store.hasToken()) {
                append("Legacy token: configured\nActive provider: Shazam/SongRec (AudD unused)")
            } else {
                append("Legacy token: not configured\n")
                append("Active provider: Shazam/SongRec (free)")
            }
        }
    }
}
