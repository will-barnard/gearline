-- V12: Add shipment tracking fields to orders
-- Populated when a Shopify fulfillments/create webhook fires after the merchant
-- adds tracking info to the shipment. Used to notify Reverb/eBay of the shipment.
--
-- ADD COLUMN IF NOT EXISTS guards are here because a failed partial run of this
-- migration may have already created the columns before the index statement failed.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS tracking_number  VARCHAR(200),
    ADD COLUMN IF NOT EXISTS tracking_carrier VARCHAR(100),
    ADD COLUMN IF NOT EXISTS tracking_url     VARCHAR(1000);

-- Index so we can look up a Gearline order by its mirrored Shopify order ID
-- (needed when a fulfillments/create webhook arrives — we have the Shopify order_id
--  and need to find the source Reverb/eBay order to notify).
CREATE INDEX IF NOT EXISTS idx_orders_shopify_order_id
    ON orders(shopify_order_id)
    WHERE shopify_order_id IS NOT NULL;
