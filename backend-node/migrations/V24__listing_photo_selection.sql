-- Hand-picked marketplace photos per variant.
--
-- By default a variant lists the photos services/variant-groups.ts
-- variantImages() works out from Shopify: its linked photo plus the unlinked
-- shots that follow it. That depends on photo ORDER in Shopify, which is easy
-- to get wrong, so the operator can pick the photos instead.
--
--   listing_image_urls  NULL      automatic (the default)
--                       [urls]    exactly these, in this order — every
--                                 marketplace gets the same list
--
-- Kept apart from image_urls, which every Shopify webhook and resync rewrites:
-- a choice made in gearline must survive Shopify edits. URLs that are no
-- longer among the product's photos are ignored when read (a photo deleted in
-- Shopify), and a selection left with nothing falls back to automatic.
--
-- On a variant-group lead it picks the photos of the whole group's listing.
-- A per-listing image_urls override in listing_overrides still wins over it.

ALTER TABLE products
    ADD COLUMN listing_image_urls JSONB NULL;
