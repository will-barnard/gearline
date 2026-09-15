-- Adds an ON_HOLD listing status for review-queue listings whose product has
-- zero Shopify quantity. These are excluded from the "ready to publish"
-- dashboard queue (which only surfaces NEEDS_REVIEW) until a Shopify sync
-- (inventory_levels/update or products/update) reports quantity > 0 again,
-- at which point they're automatically released back to NEEDS_REVIEW.
--
-- This is distinct from the existing delist-at-zero behavior, which only
-- applies to already-ACTIVE listings.

ALTER TABLE marketplace_listings
    DROP CONSTRAINT chk_listing_status;

ALTER TABLE marketplace_listings
    ADD CONSTRAINT chk_listing_status CHECK (listing_status IN (
        'PENDING','PUBLISHING','ACTIVE','INACTIVE','SOLD','DELISTED','FAILED','NEEDS_REVIEW','ON_HOLD'
    ));
