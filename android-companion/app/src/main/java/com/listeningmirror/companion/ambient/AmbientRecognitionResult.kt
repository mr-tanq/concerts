package com.listeningmirror.companion.ambient

data class AmbientRecognitionResult(
    val artist: String,
    val title: String,
    val album: String?,
    val artworkUrl: String?,
    val durationMs: Long?,
    val positionMs: Long?,
    val externalId: String?,
    val externalUrl: String?,
)
