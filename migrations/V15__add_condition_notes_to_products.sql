-- Free-text condition notes describing the item's specific flaws or notable qualities.
-- Populated from the Shopify metafield custom.condition_notes.
-- Forwarded to Reverb as condition_description when publishing listings.
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS condition_notes VARCHAR(1000);
