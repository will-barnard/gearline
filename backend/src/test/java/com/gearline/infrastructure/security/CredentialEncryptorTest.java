package com.gearline.infrastructure.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.gearline.config.GearlineProperties;
import org.junit.jupiter.api.Test;

import java.util.Base64;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CredentialEncryptorTest {

    private static final String VALID_KEY_B64 =
        Base64.getEncoder().encodeToString(new byte[32]); // 32-byte all-zeros key (test only)

    private CredentialEncryptor buildEncryptor(String keyB64) {
        GearlineProperties props = new GearlineProperties();
        GearlineProperties.Credential cred = new GearlineProperties.Credential();
        cred.setEncryptionKey(keyB64);
        props.setCredential(cred);
        CredentialEncryptor enc = new CredentialEncryptor(props, new ObjectMapper());
        enc.init();
        return enc;
    }

    // ── Encrypt / decrypt round-trips ──────────────────────────────────────────

    @Test
    void encryptDecrypt_roundTrip_restoresOriginalMap() {
        CredentialEncryptor enc = buildEncryptor(VALID_KEY_B64);
        Map<String, String> creds = Map.of(
            "access_token",  "ebay_access_token_value",
            "refresh_token", "ebay_refresh_token_value",
            "expires_at",    "9999999999999"
        );

        String ciphertext = enc.encrypt(creds);
        assertThat(ciphertext).isNotNull();
        assertThat(ciphertext).doesNotContain("access_token");  // must be opaque

        Map<String, String> decrypted = enc.decrypt(ciphertext);
        assertThat(decrypted).containsAllEntriesOf(creds);
    }

    @Test
    void encrypt_producesUniqueOutputForSameInput_dueToRandomIv() {
        CredentialEncryptor enc = buildEncryptor(VALID_KEY_B64);
        Map<String, String> creds = Map.of("access_token", "same-token");

        String ct1 = enc.encrypt(creds);
        String ct2 = enc.encrypt(creds);

        // Different IVs mean different ciphertexts for identical plaintexts
        assertThat(ct1).isNotEqualTo(ct2);
    }

    @Test
    void encrypt_nullInput_returnsNull() {
        CredentialEncryptor enc = buildEncryptor(VALID_KEY_B64);
        assertThat(enc.encrypt(null)).isNull();
    }

    @Test
    void decrypt_nullInput_returnsNull() {
        CredentialEncryptor enc = buildEncryptor(VALID_KEY_B64);
        assertThat(enc.decrypt(null)).isNull();
    }

    // ── Pass-through mode (no key configured) ─────────────────────────────────

    @Test
    void passthroughMode_encryptReturnsPlainJson() {
        CredentialEncryptor enc = buildEncryptor(""); // blank key → pass-through
        Map<String, String> creds = Map.of("access_token", "plaintext-token");

        String stored = enc.encrypt(creds);
        assertThat(stored).contains("plaintext-token");  // plain JSON
    }

    @Test
    void passthroughMode_decryptParsesPlainJson() {
        CredentialEncryptor enc = buildEncryptor("");
        String json = "{\"access_token\":\"plaintext-token\"}";
        Map<String, String> result = enc.decrypt(json);
        assertThat(result.get("access_token")).isEqualTo("plaintext-token");
    }

    @Test
    void passthroughMode_roundTrip_restoresMap() {
        CredentialEncryptor enc = buildEncryptor("");
        Map<String, String> creds = Map.of("access_token", "tok", "refresh_token", "ref");
        assertThat(enc.decrypt(enc.encrypt(creds))).containsAllEntriesOf(creds);
    }

    // ── Key validation ────────────────────────────────────────────────────────

    @Test
    void init_keyTooShort_throwsIllegalStateException() {
        // Encode only 16 bytes — less than required 32
        String shortKey = Base64.getEncoder().encodeToString(new byte[16]);
        assertThatThrownBy(() -> buildEncryptor(shortKey))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("32 bytes");
    }
}
