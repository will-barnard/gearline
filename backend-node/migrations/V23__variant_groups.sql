-- Variant groups: list several Shopify variants as ONE marketplace listing.
--
-- Custom Rhodes lids come in sizes × cuts × many colours. Listing every colour
-- on Reverb/eBay would mean dozens of near-identical listings, so the colour is
-- collapsed: one listing per size × cut, and the buyer tells us the colour
-- after ordering. A grouping is configured per Shopify product by naming the
-- option(s) to collapse.
--
-- ── 1. What a variant is, per row ────────────────────────────────────────────
--
-- Grouping needs each variant's option values, and the photos need each
-- variant's own image. Neither was stored: rows only kept the rendered title.
--
--   variant_options    [{ "name": "Color", "value": "Black" }, ...] in
--                      Shopify option order. [] until the next webhook/resync.
--   variant_position   Shopify's 1-based variant position. Picks the default
--                      lead and orders photos.
--   variant_image_url  The variant's own image (variant.image_id), if any.
--
-- ── 2. The grouping config ───────────────────────────────────────────────────
--
-- One row per Shopify product. lead_variant_ids are explicit lead choices; a
-- group with none of its variants listed here leads with its first variant.
-- buyer_note replaces the default "message us your choice" sentence.
--
-- ── 3. Resolved membership ───────────────────────────────────────────────────
--
-- variant_group_lead_id is DERIVED from the config by services/variant-groups.ts
-- regroupProduct(), never edited directly. It is stored rather than computed on
-- read so that eligibility stays a pure check on the row:
--
--   NULL          not grouped (ordinary behaviour)
--   = own id      the group's lead — the only row that gets listings
--   = other id    a member — sold through the lead's listing, never listed

ALTER TABLE products
    ADD COLUMN variant_options JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN variant_position INTEGER NULL,
    ADD COLUMN variant_image_url TEXT NULL,
    ADD COLUMN variant_group_lead_id UUID NULL REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX idx_products_variant_group_lead ON products (variant_group_lead_id)
    WHERE variant_group_lead_id IS NOT NULL;

CREATE TABLE variant_groupings (
    shopify_product_id VARCHAR(64) PRIMARY KEY,
    collapsed_options  TEXT[] NOT NULL,
    lead_variant_ids   TEXT[] NOT NULL DEFAULT '{}',
    buyer_note         TEXT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_variant_groupings_collapsed CHECK (cardinality(collapsed_options) >= 1)
);
