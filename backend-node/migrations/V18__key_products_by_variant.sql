-- Re-key Shopify-sourced products on the VARIANT rather than the product.
--
-- Ingestion previously read variants[0] and discarded the rest, so a
-- multi-variant Shopify product became a single products row carrying variant
-- 1's SKU, price, stock and inventory item. Variants past the first had no row
-- at all, which also meant inventory_levels/update — which matches on
-- shopify_inventory_item_id — silently did nothing for them.
--
-- No data migration is needed. Rows written by the webhook processor already
-- carry variants[0]'s shopify_variant_id, so every existing row is already a
-- correct variant-1 row and keeps its id, its SKU and its listings. The
-- backfill for variants 2..n happens through a normal product resync.

-- Fail with an actionable message rather than a bare unique_violation.
--
-- If two rows already claim one variant, CREATE UNIQUE INDEX below aborts with
-- "could not create unique index" and names the index, not the data. This block
-- names the variant ids and SKUs involved, which is what anyone reading a
-- failed deploy log actually needs.
--
-- migrate.ts runs each migration in its own transaction together with its
-- history row, so raising here rolls the whole thing back cleanly: no partial
-- schema, no FAILED history entry to clear by hand, and the previously deployed
-- container keeps serving.
DO $$
DECLARE
    offenders TEXT;
BEGIN
    SELECT string_agg(detail, '; ')
    INTO   offenders
    FROM (
        SELECT shopify_variant_id || ' held by ' || string_agg(sku, ' + ') AS detail
        FROM   products
        WHERE  shopify_variant_id IS NOT NULL
        GROUP  BY shopify_variant_id
        HAVING COUNT(*) > 1
    ) dupes;

    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot key products by variant: % product row(s) share a Shopify variant id. %',
            'two or more', offenders
        USING HINT = 'Merge or delete the duplicate rows, then redeploy. Nothing has been changed.';
    END IF;
END $$;

-- Identity for Shopify-sourced products. PARTIAL so that products created by
-- hand through POST /products, which have no variant id, stay exempt rather
-- than colliding with each other on NULL.
CREATE UNIQUE INDEX uq_products_shopify_variant
    ON products(shopify_variant_id)
    WHERE shopify_variant_id IS NOT NULL;

-- inventory_levels/update looks up by this on every stock change, and is about
-- to run against several times as many rows.
CREATE INDEX idx_products_shopify_inventory_item
    ON products(shopify_inventory_item_id)
    WHERE shopify_inventory_item_id IS NOT NULL;

COMMENT ON COLUMN products.shopify_variant_id IS
    'Identity for Shopify-sourced products: one row per VARIANT, not per product';
