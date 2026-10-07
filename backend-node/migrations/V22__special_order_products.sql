-- Special-order products: stock 0 in Shopify, but still orderable (Shopify
-- "continue selling when out of stock") with a lead time, such as dealer items
-- ordered on demand.
--
-- Everything downstream reads "how many can a customer buy on a marketplace?"
-- from one place. For most products that is just `quantity`. For a special-order
-- product at quantity 0 it is this column instead, so the listing stays up
-- rather than being delisted or held when stock reaches zero.
--
--   NULL   not special order (the default; behaviour is unchanged)
--   n >= 1 special order. The quantity shown on marketplaces while real stock
--          is 0. Real stock, when there is any, always wins.
--
-- Written from the Shopify product tag on every product webhook (see
-- services/special-order.ts), never edited by hand, so removing the tag in
-- Shopify turns it off on the next update.
--
-- At least 2 is enforced by the application's default, not this constraint: a
-- listing at 1 ends when it sells, and a sold-out listing cannot be assumed to
-- come back from an inventory update. The constraint only keeps nonsense out.

ALTER TABLE products
    ADD COLUMN special_order_quantity INTEGER NULL;

ALTER TABLE products
    ADD CONSTRAINT chk_products_special_order_quantity
    CHECK (special_order_quantity IS NULL OR special_order_quantity >= 1);
