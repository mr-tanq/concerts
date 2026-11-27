package com.yoda.pet

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import kotlin.concurrent.thread

/** Receives yoda-pet://spotify-callback after Spotify sign-in. */
class SpotifyCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val data = intent?.data
        if (data == null) { finish(); return }
        thread {
            val result = SpotifyClient(this).finishSignIn(data)
            runOnUiThread {
                val msg = result.fold({ "Spotify connected as $it 🎵" }, { "Spotify: ${it.message}" })
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                finish()
            }
        }
    }
}
