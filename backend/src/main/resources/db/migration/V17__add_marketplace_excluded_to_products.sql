-- Adds a flag that permanently suppresses marketplace listing creation for a product.
-- Used for Shopify-only items (e.g. deposit listings, restoration placeholders) that
-- should never appear on eBay or Reverb regardless of their Shopify status.
--
-- This flag is set ONLY by Gearline users — Shopify webhooks can never clear it.
-- When true: no NEEDS_REVIEW stubs are created, existing stubs are removed, and any
-- active marketplace listings are delisted.

ALTER TABLE products
    ADD COLUMN marketplace_excluded BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_products_marketplace_excluded
    ON products (marketplace_excluded)
    WHERE marketplace_excluded = TRUE;
