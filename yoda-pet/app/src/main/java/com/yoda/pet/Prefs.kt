package com.yoda.pet

import android.content.Context

class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("yoda", Context.MODE_PRIVATE)

    var yodaEnabled: Boolean
        get() = sp.getBoolean("enabled", false)
        set(v) = sp.edit().putBoolean("enabled", v).apply()

    var emailAlerts: Boolean
        get() = sp.getBoolean("email_alerts", true)
        set(v) = sp.edit().putBoolean("email_alerts", v).apply()

    var meetingAlerts: Boolean
        get() = sp.getBoolean("meeting_alerts", true)
        set(v) = sp.edit().putBoolean("meeting_alerts", v).apply()

    /** Yoda's height on screen, in dp. */
    var petSizeDp: Int
        get() = sp.getInt("pet_size_dp", 96)
        set(v) = sp.edit().putInt("pet_size_dp", v).apply()

    var announcedMeetings: Set<String>
        get() = sp.getStringSet("announced", emptySet()) ?: emptySet()
        set(v) = sp.edit().putStringSet("announced", v).apply()

    // Spotify session
    var spotifyAccess: String?
        get() = sp.getString("sp_access", null)
        set(v) = sp.edit().putString("sp_access", v).apply()
    var spotifyRefresh: String?
        get() = sp.getString("sp_refresh", null)
        set(v) = sp.edit().putString("sp_refresh", v).apply()
    var spotifyExpiresAt: Long
        get() = sp.getLong("sp_expires", 0)
        set(v) = sp.edit().putLong("sp_expires", v).apply()
    var spotifyVerifier: String?
        get() = sp.getString("sp_verifier", null)
        set(v) = sp.edit().putString("sp_verifier", v).apply()
    var spotifyState: String?
        get() = sp.getString("sp_state", null)
        set(v) = sp.edit().putString("sp_state", v).apply()
    var spotifyUser: String?
        get() = sp.getString("sp_user", null)
        set(v) = sp.edit().putString("sp_user", v).apply()

    fun clearSpotify() {
        sp.edit().remove("sp_access").remove("sp_refresh").remove("sp_expires")
            .remove("sp_verifier").remove("sp_state").remove("sp_user").apply()
    }
}
