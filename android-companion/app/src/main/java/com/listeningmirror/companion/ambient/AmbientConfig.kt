package com.listeningmirror.companion.ambient

object AmbientConfig {
    // Kept as ambient_audd for web/relay backward compatibility: the Mirror
    // currently maps this source id to the radio icon. Recognition provider
    // is now Shazam/SongRec internally.
    const val SOURCE = "ambient_audd"
    const val PROVIDER = "Shazam/SongRec"

    // Phase 3 free Shazam path. SongRec fingerprints require 16 kHz mono PCM16.
    const val SHAZAM_SAMPLE_RATE_HZ = 16_000
    const val SHAZAM_FAST_SAMPLE_MS = 3_000L
    const val SHAZAM_SECOND_SAMPLE_MS = 6_000L

    // Legacy AudD settings are intentionally retained for manual rollback;
    // Phase 3 does NOT call AudD automatically, so recognition cannot create
    // an AudD bill or consume its quota behind the user's back.
    const val PUBLIC_TEST_TOKEN = "test"
    const val SAMPLE_RATE_HZ = 44_100
    const val SAMPLE_DURATION_MS = 8_000L

    // Local signal gate: never send a fingerprint for near-silence.
    const val MIN_RMS_DBFS = -55.0
    const val MIN_PEAK_DBFS = -42.0

    // Retry policy. Unknown duration is common in Shazam results; rechecking
    // after 30s keeps radio changes reasonably fresh without hammering the
    // undocumented endpoint continuously.
    const val NO_MATCH_RETRY_MS = 6_000L
    const val UNKNOWN_DURATION_RETRY_MS = 30_000L
    const val MIN_MATCH_RETRY_MS = 20_000L
    const val MAX_MATCH_RETRY_MS = 180_000L
    const val BEFORE_EXPECTED_END_MS = 4_000L
    const val DEVICE_PLAYBACK_RECHECK_MS = 5_000L
}
