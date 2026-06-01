-- V11: Marketplace pricing profiles
-- Allows per-account percentage markup/markdown applied at sync time.
-- finalPrice = product.price × (1 + adjustment_percent / 100), rounded to 2dp.

CREATE TABLE pricing_profiles (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR(200) NOT NULL,
    adjustment_percent NUMERIC(7, 4) NOT NULL DEFAULT 0,
    active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FK from marketplace_accounts; nullable — no profile means use product.price as-is
ALTER TABLE marketplace_accounts
    ADD COLUMN pricing_profile_id UUID REFERENCES pricing_profiles(id) ON DELETE SET NULL;

CREATE INDEX idx_marketplace_accounts_pricing_profile
    ON marketplace_accounts(pricing_profile_id)
    WHERE pricing_profile_id IS NOT NULL;
