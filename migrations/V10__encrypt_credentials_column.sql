-- V10: Change encrypted_credentials from jsonb to text
--
-- The application now encrypts credential values with AES-256-GCM before
-- storing them. The resulting value is an opaque Base64 string, not valid
-- JSON, so the column type must be TEXT rather than JSONB.
--
-- When CREDENTIAL_ENCRYPTION_KEY is not set (dev/CI), the application stores
-- plain JSON strings which are also valid TEXT.
--
-- Existing rows: cast the existing JSONB value to TEXT so no data is lost.
-- On a fresh deployment there are no existing rows, so the cast is a no-op.

ALTER TABLE marketplace_accounts
    ALTER COLUMN encrypted_credentials TYPE TEXT
    USING encrypted_credentials::TEXT;
