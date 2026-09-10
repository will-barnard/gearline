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

-- ── Repair rows that share a variant id ──────────────────────────────────────
--
-- The old insert used ON CONFLICT (sku) DO UPDATE, and the update set included
-- shopify_variant_id. So when a NEW Shopify product first arrived carrying a
-- SKU that an EXISTING row already held, the insert did not create a row — it
-- overwrote the existing one with the new product's variant id, title and
-- price, while leaving its shopify_product_id pointing at the original product.
-- Correcting the SKU in Shopify afterwards then created the row that should
-- have existed all along, leaving two rows claiming one variant.
--
-- Nulling the identity columns on every row in such a group is safe and
-- self-healing: the columns are exempt from the partial index below while null,
-- and ingestion re-keys each row from its own shopify_product_id on the next
-- product sync, which is where the correct variant id comes from anyway. No row
-- is deleted and no listing is touched — listings key on the product's UUID.
--
-- Rows whose Shopify product no longer exists simply stay unkeyed, which is
-- the state they were already in before this migration.
DO $$
DECLARE
    repaired INT;
    detail   TEXT;
BEGIN
    SELECT string_agg(d, '; ')
    INTO   detail
    FROM (
        SELECT shopify_variant_id || ' was claimed by ' || string_agg(sku, ' + ') AS d
        FROM   products
        WHERE  shopify_variant_id IS NOT NULL
        GROUP  BY shopify_variant_id
        HAVING COUNT(*) > 1
    ) dupes;

    IF detail IS NULL THEN
        RETURN; -- nothing to repair
    END IF;

    WITH duplicated AS (
        SELECT shopify_variant_id
        FROM   products
        WHERE  shopify_variant_id IS NOT NULL
        GROUP  BY shopify_variant_id
        HAVING COUNT(*) > 1
    )
    UPDATE products p
    SET    shopify_variant_id        = NULL,
           shopify_inventory_item_id = NULL,
           updated_at                = NOW()
    FROM   duplicated d
    WHERE  p.shopify_variant_id = d.shopify_variant_id;

    GET DIAGNOSTICS repaired = ROW_COUNT;

    RAISE WARNING
        'Unlinked % product row(s) that shared a Shopify variant id: %. '
        'Run "Sync Products" on the Shopify account to re-key them.',
        repaired, detail;
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
