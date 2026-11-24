package com.listeningmirror.companion.transport

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores the write secret encrypted with a non-exportable Android Keystore
 * AES/GCM key.
 *
 * Deliberately NOT androidx.security.crypto EncryptedSharedPreferences /
 * MasterKey -- those are deprecated. This is the current platform-supported
 * path and needs no dependency at all: the Keystore holds the key (which
 * never leaves it), and only ciphertext+IV land on disk.
 *
 * Ciphertext also lives under noBackupFilesDir: restoring it to a new
 * install would be useless anyway (the Keystore key is device/install-bound
 * and would not be restored with it), so backing it up could only produce a
 * confusing undecryptable blob rather than working credentials. Requiring
 * re-entry after reinstall is the intended lifecycle.
 */
class DeviceSecretStore(context: Context) {

    private val dir = File(context.noBackupFilesDir, "transport").apply { mkdirs() }
    private val blobFile = File(dir, "write_secret.bin")

    fun hasSecret(): Boolean = blobFile.exists()

    fun clear() { blobFile.delete() }

    fun save(secret: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val ct = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
        // [1 byte iv length][iv][ciphertext]
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
            val ivLen = blob[0].toInt()
            if (blob.size < 1 + ivLen) return null
            val iv = blob.copyOfRange(1, 1 + ivLen)
            val ct = blob.copyOfRange(1 + ivLen, blob.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (e: Exception) {
            // Key invalidated, blob corrupt, or restored from another install.
            // Fail closed and require re-entry rather than crashing.
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
        const val KEY_ALIAS = "lm_transport_write_secret"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
    }
}
