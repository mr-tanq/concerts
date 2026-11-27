package com.yoda.pet.logic

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** OAuth PKCE helpers (RFC 7636) for Spotify sign-in without a client secret. */
object Pkce {
    private val enc = Base64.getUrlEncoder().withoutPadding()

    fun newVerifier(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(48).also(random::nextBytes)
        return enc.encodeToString(bytes) // 64 URL-safe chars
    }

    fun challenge(verifier: String): String =
        enc.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
}
