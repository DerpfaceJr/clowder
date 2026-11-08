package com.derpfacejr.clowder;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Seals short strings with an AES-256-GCM key that lives in the Android Keystore and never leaves it.
 * A sealed value is base64(12-byte IV || ciphertext with tag). Any Keystore failure gives null, never plain text.
 */
final class Vault {
    private static final String STORE = "AndroidKeyStore";
    private static final String ALIAS = "clowder-prefs";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final int IV_BYTES = 12;

    private Vault() {
    }

    /** The sealed form of a value, or null when the value is null or the Keystore refuses. */
    static String seal(String value) {
        if (value == null) {
            return null;
        }
        try {
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] body = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            if (iv.length != IV_BYTES) {
                return null;
            }
            byte[] all = new byte[iv.length + body.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(body, 0, all, iv.length, body.length);
            return Base64.encodeToString(all, Base64.NO_WRAP);
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            return null;
        }
    }

    /** The value inside a sealed string, or null when it is null, damaged, or the key is gone. */
    static String open(String sealed) {
        if (sealed == null) {
            return null;
        }
        try {
            byte[] all = Base64.decode(sealed, Base64.NO_WRAP);
            if (all.length <= IV_BYTES) {
                return null;
            }
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, IV_BYTES));
            return new String(cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            // RuntimeException covers bad base64 and the Keystore's ProviderException.
            return null;
        }
    }

    private static Key key() throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance(STORE);
        store.load(null);
        Key key = store.getKey(ALIAS, null);
        if (key != null) {
            return key;
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
