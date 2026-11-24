package com.listeningmirror.companion.ambient

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypted, no-backup storage for the user's AudD API token. */
class AmbientTokenStore(context: Context) {
    private val dir = File(context.noBackupFilesDir, "ambient").apply { mkdirs() }
    private val blobFile = File(dir, "audd_token.bin")

    fun hasToken(): Boolean = load() != null
    fun clear() { blobFile.delete() }

    fun save(token: String) {
        val cleaned = token.trim()
        require(cleaned.isNotEmpty())
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val ct = cipher.doFinal(cleaned.toByteArray(Charsets.UTF_8))
        val out = ByteArray(1 + iv.size + ct.size)
        out[0] = iv.size.toByte()
        System.arraycopy(iv, 0, out, 1, iv.size)
        System.arraycopy(ct, 0, out, 1 + iv.size, ct.size)
        blobFile.writeBytes(out)
    }

    fun load(): String? {
        if (!blobFile.exists()) return null
        return try {
            val blob = blobFile.readBytes()
            if (blob.isEmpty()) return null
            val ivLen = blob[0].toInt() and 0xff
            if (ivLen <= 0 || blob.size <= 1 + ivLen) return null
            val iv = blob.copyOfRange(1, 1 + ivLen)
            val ct = blob.copyOfRange(1 + ivLen, blob.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8).trim().takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = java.security.KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? java.security.KeyStore.SecretKeyEntry)
            ?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "lm_ambient_audd_token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
    }
}
