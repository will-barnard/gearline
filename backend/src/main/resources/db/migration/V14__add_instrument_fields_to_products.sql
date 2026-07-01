-- Instrument-specific fields used across marketplace listings.
-- Populated from Shopify metafields custom.reverb_model, custom.reverb_year,
-- and custom.reverb_finish, and forwarded to Reverb at publish time.
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS model      VARCHAR(200),
    ADD COLUMN IF NOT EXISTS year_made  VARCHAR(20),   -- string so "circa 1965" is valid
    ADD COLUMN IF NOT EXISTS finish     VARCHAR(100);
