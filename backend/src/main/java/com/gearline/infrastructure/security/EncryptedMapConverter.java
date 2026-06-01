package com.gearline.infrastructure.security;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

import java.util.Map;

/**
 * JPA {@link AttributeConverter} that transparently encrypts and decrypts
 * {@code Map<String, String>} credential values at the persistence boundary.
 *
 * Encryption is handled by {@link CredentialEncryptor} (AES-256-GCM).
 * If {@code CREDENTIAL_ENCRYPTION_KEY} is not configured, the encryptor
 * operates in pass-through mode and credentials are stored as plain JSON.
 *
 * Applied explicitly with {@code @Convert(converter = EncryptedMapConverter.class)}
 * on {@link com.gearline.domain.marketplace.MarketplaceAccount#encryptedCredentials}.
 */
@Converter
public class EncryptedMapConverter implements AttributeConverter<Map<String, String>, String> {

    @Override
    public String convertToDatabaseColumn(Map<String, String> attribute) {
        if (attribute == null) return null;
        return CredentialEncryptor.getInstance().encrypt(attribute);
    }

    @Override
    public Map<String, String> convertToEntityAttribute(String dbData) {
        if (dbData == null) return null;
        return CredentialEncryptor.getInstance().decrypt(dbData);
    }
}
