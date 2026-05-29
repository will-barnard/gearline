-- Marketplace listings: one per product per connected marketplace account
CREATE TABLE marketplace_listings (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace_account_id  UUID NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
    marketplace_type        VARCHAR(30) NOT NULL,

    -- Identifier on the external marketplace
    external_listing_id     VARCHAR(200),

    listing_status          VARCHAR(30) NOT NULL DEFAULT 'PENDING',

    -- Last synced values (may differ from canonical product data due to overrides)
    synced_price            NUMERIC(10, 2),
    synced_quantity         INTEGER,
    last_sync_at            TIMESTAMPTZ,

    -- Error tracking
    last_error              TEXT,
    error_count             INTEGER NOT NULL DEFAULT 0,

    -- Marketplace-specific overrides (custom title/description/pricing for this channel)
    listing_overrides       JSONB NOT NULL DEFAULT '{}',

    -- Opaque metadata returned by the external marketplace API
    marketplace_metadata    JSONB NOT NULL DEFAULT '{}',

    version                 BIGINT NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_listing_status CHECK (listing_status IN (
        'PENDING','PUBLISHING','ACTIVE','INACTIVE','SOLD','DELISTED','FAILED','NEEDS_REVIEW'
    )),
    -- Prevent duplicate listings for the same product+account combination
    CONSTRAINT uq_listing_product_account UNIQUE (product_id, marketplace_account_id)
);

CREATE INDEX idx_listings_product_id ON marketplace_listings(product_id);
CREATE INDEX idx_listings_account_id ON marketplace_listings(marketplace_account_id);
CREATE INDEX idx_listings_external_id ON marketplace_listings(external_listing_id);
CREATE INDEX idx_listings_status ON marketplace_listings(listing_status);
CREATE INDEX idx_listings_type_external ON marketplace_listings(marketplace_type, external_listing_id);
CREATE INDEX idx_listings_needs_sync ON marketplace_listings(listing_status, last_sync_at)
    WHERE listing_status IN ('ACTIVE','NEEDS_REVIEW');

COMMENT ON TABLE marketplace_listings IS 'Per-channel listing state — all marketplace-specific data lives here, not on products';
COMMENT ON COLUMN marketplace_listings.listing_overrides IS 'Custom title, description, price, category for this specific channel';
COMMENT ON COLUMN marketplace_listings.marketplace_metadata IS 'Raw metadata from external marketplace API (URLs, IDs, etc.)';
