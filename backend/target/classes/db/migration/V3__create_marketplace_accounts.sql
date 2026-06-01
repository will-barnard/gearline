-- Connected marketplace accounts (Shopify stores, eBay accounts, Reverb shops)
CREATE TABLE marketplace_accounts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    marketplace_type        VARCHAR(30) NOT NULL,
    display_name            VARCHAR(200) NOT NULL,
    external_account_id     VARCHAR(200),
    external_shop_url       VARCHAR(500),

    -- Encrypted OAuth credentials stored as JSON
    -- Values are AES-encrypted before persistence
    encrypted_credentials   JSONB,

    -- Marketplace-specific sync config (polling intervals, feature flags, etc.)
    sync_settings           JSONB NOT NULL DEFAULT '{}',

    active                  BOOLEAN NOT NULL DEFAULT TRUE,
    connection_status       VARCHAR(20) NOT NULL DEFAULT 'DISCONNECTED',
    last_sync_at            TIMESTAMPTZ,
    last_error              TEXT,
    version                 BIGINT NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_marketplace_type CHECK (marketplace_type IN ('SHOPIFY','EBAY','REVERB')),
    CONSTRAINT chk_connection_status CHECK (connection_status IN (
        'CONNECTED','DISCONNECTED','TOKEN_EXPIRED','ERROR','PENDING_OAUTH'
    ))
);

CREATE INDEX idx_marketplace_accounts_type ON marketplace_accounts(marketplace_type);
CREATE INDEX idx_marketplace_accounts_external_id ON marketplace_accounts(external_account_id);
CREATE INDEX idx_marketplace_accounts_active ON marketplace_accounts(active);

COMMENT ON TABLE marketplace_accounts IS 'Connected external marketplace accounts with encrypted OAuth credentials';
COMMENT ON COLUMN marketplace_accounts.encrypted_credentials IS 'AES-encrypted OAuth tokens — never stored in plaintext';
