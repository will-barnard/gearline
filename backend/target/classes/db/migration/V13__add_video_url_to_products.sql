-- Stores a YouTube (or other) video URL associated with the product.
-- Populated from the Shopify product metafield custom.youtube_url and
-- forwarded to Reverb as video_link when publishing listings.
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS video_url VARCHAR(500);
