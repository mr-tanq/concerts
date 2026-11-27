package com.yoda.pet

import android.os.Handler
import android.os.Looper

/** Lets the Gmail listener and the service reach the on-screen pet, if it is running. */
object PetBus {
    @Volatile
    var overlay: PetOverlay? = null

    private val main = Handler(Looper.getMainLooper())

    fun post(block: (PetOverlay) -> Unit) {
        if (overlay == null) return
        main.post { overlay?.let(block) }
    }
}
