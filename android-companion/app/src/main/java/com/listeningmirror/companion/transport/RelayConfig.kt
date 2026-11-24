package com.listeningmirror.companion.transport

/**
 * Public client configuration. Neither value is a secret: the project URL is
 * an address, and the publishable/anon key is designed to be shipped in
 * clients. Neither grants any access on its own -- the private schema is
 * unreachable to the anon role (no USAGE, no table grants, RLS on with zero
 * policies), and the only exposed surface is two SECURITY DEFINER functions
 * that each require the separately-entered transport secret.
 *
 * Shipping these as ordinary config is what keeps manual setup down to one
 * pasted secret.
 */
object RelayConfig {
    const val PROJECT_URL = "https://lsnhmthhtjinyidnojiq.supabase.co"
    const val ANON_KEY = "sb_publishable_LZByzzlMw_FoZ2Qgw3idkw_Isey-exW"

    const val SCHEMA_VERSION = 1
    const val PUBLISH_RPC = "/rest/v1/rpc/publish_playback"
    const val AMBIENT_CONTROL_READ_RPC = "/rest/v1/rpc/read_ambient_control"
    const val AMBIENT_CONTROL_ACK_RPC = "/rest/v1/rpc/ack_ambient_control"
    const val AMBIENT_CONTROL_POLL_MS = 3_000L

    const val DEBOUNCE_MS = 750L
    const val HEARTBEAT_MS = 20_000L
    val RETRY_BACKOFF_MS = longArrayOf(2_000L, 5_000L, 15_000L)
}
