package com.gearline.infrastructure.security;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gearline.config.GearlineProperties;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;

/**
 * AES-256-GCM credential encryptor for marketplace OAuth tokens.
 *
 * The encryption key is read from {@code CREDENTIAL_ENCRYPTION_KEY} (a Base64-encoded
 * 32-byte secret). If the key is blank — e.g. during local development without the
 * variable set — the encryptor operates in pass-through mode (no encryption).
 *
 * Pass-through mode is intentional: it prevents startup failures on developer
 * machines and CI environments where the key is not configured.  Do NOT run
 * without a key in production.
 *
 * Wire-format: Base64( IV(12 bytes) || GCM_ciphertext_and_tag )
 * The ciphertext is a JSON-serialized Map<String,String>.
 *
 * This class exposes a static accessor used by {@link EncryptedMapConverter}, which
 * is instantiated by Hibernate outside the Spring context.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class CredentialEncryptor {

    private static final String ALGORITHM = "AES/GCM/NoPadding";
    private static final int GCM_IV_LENGTH  = 12;   // bytes
    private static final int GCM_TAG_LENGTH = 128;  // bits

    // Static accessor for JPA converter
    private static CredentialEncryptor INSTANCE;

    private final GearlineProperties properties;
    private final ObjectMapper objectMapper;

    private SecretKey secretKey;
    private boolean encryptionEnabled;

    @PostConstruct
    void init() {
        String rawKey = properties.getCredential() != null
            ? properties.getCredential().getEncryptionKey()
            : null;

        if (rawKey == null || rawKey.isBlank()) {
            log.warn("CREDENTIAL_ENCRYPTION_KEY is not set — marketplace credentials will be " +
                "stored unencrypted. Set this variable before deploying to production.");
            encryptionEnabled = false;
        } else {
            try {
                byte[] keyBytes = Base64.getDecoder().decode(rawKey.trim());
                if (keyBytes.length < 32) {
                    throw new IllegalArgumentException(
                        "CREDENTIAL_ENCRYPTION_KEY must decode to at least 32 bytes (256-bit AES key). " +
                        "Generate one with: openssl rand -base64 32");
                }
                // Use exactly 32 bytes (AES-256)
                byte[] key256 = new byte[32];
                System.arraycopy(keyBytes, 0, key256, 0, 32);
                secretKey = new SecretKeySpec(key256, "AES");
                encryptionEnabled = true;
                log.info("Credential encryption enabled (AES-256-GCM)");
            } catch (IllegalArgumentException e) {
                throw new IllegalStateException("Invalid CREDENTIAL_ENCRYPTION_KEY: " + e.getMessage(), e);
            }
        }

        INSTANCE = this;
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Encrypts a credential map to a Base64-encoded ciphertext string.
     * Returns the JSON string unchanged if encryption is disabled.
     */
    public String encrypt(Map<String, String> credentials) {
        if (credentials == null) return null;
        try {
            String json = objectMapper.writeValueAsString(credentials);
            if (!encryptionEnabled) return json;

            byte[] plaintext = json.getBytes(StandardCharsets.UTF_8);

            byte[] iv = new byte[GCM_IV_LENGTH];
            new SecureRandom().nextBytes(iv);

            Cipher cipher = Cipher.getInstance(ALGORITHM);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH, iv));
            byte[] ciphertext = cipher.doFinal(plaintext);

            // Prepend IV to ciphertext
            byte[] combined = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(ciphertext, 0, combined, iv.length, ciphertext.length);

            return Base64.getEncoder().encodeToString(combined);

        } catch (Exception e) {
            throw new RuntimeException("Failed to encrypt credentials", e);
        }
    }

    /**
     * Decrypts a ciphertext string back to a credential map.
     * If encryption is disabled, attempts to parse as plain JSON.
     */
    public Map<String, String> decrypt(String stored) {
        if (stored == null) return null;
        try {
            String json;
            if (!encryptionEnabled) {
                json = stored;
            } else {
                byte[] combined = Base64.getDecoder().decode(stored);
                byte[] iv         = new byte[GCM_IV_LENGTH];
                byte[] ciphertext = new byte[combined.length - GCM_IV_LENGTH];
                System.arraycopy(combined, 0, iv, 0, GCM_IV_LENGTH);
                System.arraycopy(combined, GCM_IV_LENGTH, ciphertext, 0, ciphertext.length);

                Cipher cipher = Cipher.getInstance(ALGORITHM);
                cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH, iv));
                byte[] plaintext = cipher.doFinal(ciphertext);
                json = new String(plaintext, StandardCharsets.UTF_8);
            }
            return objectMapper.readValue(json, new TypeReference<Map<String, String>>() {});
        } catch (Exception e) {
            throw new RuntimeException("Failed to decrypt credentials", e);
        }
    }

    // ── Static accessor for JPA converter ─────────────────────────────────────

    static CredentialEncryptor getInstance() {
        if (INSTANCE == null) {
            throw new IllegalStateException(
                "CredentialEncryptor has not been initialized by Spring yet. " +
                "Ensure the Spring context is fully started before JPA operations.");
        }
        return INSTANCE;
    }
}
