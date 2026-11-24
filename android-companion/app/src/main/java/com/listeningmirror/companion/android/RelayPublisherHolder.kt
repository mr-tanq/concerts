package com.listeningmirror.companion.android

import com.listeningmirror.companion.transport.RelayPublisher

/**
 * Lets the settings Activity reach the service-owned publisher to save the
 * secret and read publish status. Same single-process reasoning as
 * ObservationHub: a Binder round trip would add real complexity for no
 * behavioral gain in a debug tool.
 *
 * The publisher's LIFECYCLE still belongs entirely to the service -- this
 * only hands out a reference, it never starts or stops anything.
 */
object RelayPublisherHolder {
    @Volatile private var publisher: RelayPublisher? = null
    fun set(p: RelayPublisher?) { publisher = p }
    fun get(): RelayPublisher? = publisher
}
