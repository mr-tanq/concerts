package com.yoda.pet

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings

/** Brings Yoda back after a reboot or an app update, if she was on before. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs(context).yodaEnabled && Settings.canDrawOverlays(context)) {
            runCatching { YodaService.start(context) }
        }
    }
}
