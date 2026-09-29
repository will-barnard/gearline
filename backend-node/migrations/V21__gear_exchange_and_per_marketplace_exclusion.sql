-- Two changes that ship together because the second exists for the first.
--
-- 1. GEAR_EXCHANGE becomes a valid marketplace type.
--
--    Only marketplace_accounts carries a CHECK on the type (V3). The listings,
--    orders, sync_jobs and audit_events tables store it as plain VARCHAR(30),
--    so they need no change.
--
-- 2. Per-marketplace product exclusion.
--
--    marketplace_excluded (V17) is all-or-nothing: "never on eBay or Reverb".
--    Sweetwater's Gear Exchange bans clothing outright, so a branded t-shirt
--    must stay listable on Reverb and eBay while never reaching Gear Exchange.
--    excluded_marketplaces holds the marketplace TYPES a product must not be
--    listed on. Types rather than account ids on purpose: the reason for an
--    exclusion is almost always the marketplace's rules, which apply to every
--    account on it, and a type survives an account being reconnected.
--
--    marketplace_excluded keeps its meaning and still wins — a product excluded
--    everywhere is excluded everywhere regardless of this array.

ALTER TABLE marketplace_accounts
    DROP CONSTRAINT chk_marketplace_type;

ALTER TABLE marketplace_accounts
    ADD CONSTRAINT chk_marketplace_type CHECK (marketplace_type IN ('SHOPIFY','EBAY','REVERB','GEAR_EXCHANGE'));

ALTER TABLE products
    ADD COLUMN excluded_marketplaces TEXT[] NOT NULL DEFAULT '{}';

-- Supports "which products are kept off marketplace X" without a table scan.
CREATE INDEX idx_products_excluded_marketplaces
    ON products USING GIN (excluded_marketplaces);
