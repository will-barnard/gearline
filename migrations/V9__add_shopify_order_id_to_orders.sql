-- Track which Gearline orders have been mirrored to Shopify.
-- When a Reverb or eBay order is imported, Gearline creates a corresponding
-- order in Shopify via the Admin API so it appears on the store's Orders page.
-- This column stores the resulting Shopify order ID (numeric string like "5678901234567").
-- NULL means the order has not yet been pushed to Shopify.
ALTER TABLE orders
    ADD COLUMN shopify_order_id VARCHAR(100);

CREATE INDEX idx_orders_shopify_order_id ON orders(shopify_order_id)
    WHERE shopify_order_id IS NOT NULL;
