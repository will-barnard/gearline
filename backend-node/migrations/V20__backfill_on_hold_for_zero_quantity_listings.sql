-- One-time backfill for the ON_HOLD status introduced in V19.
--
-- The hold/release logic that keeps NEEDS_REVIEW and ON_HOLD in sync with
-- stock only runs when a Shopify webhook or inventory propagation touches a
-- product (see upsertReviewListings in webhook-processor.ts and
-- holdOrReleaseReviewListings in inventory-consistency.ts). It is a forward
-- fix, not a retroactive one: a listing that was already sitting in
-- NEEDS_REVIEW with 0 stock before this deploy stays NEEDS_REVIEW — and kept
-- showing up as "ready to publish" — until some future webhook happens to
-- fire for that exact product.
--
-- This reconciles the existing data once: any NEEDS_REVIEW listing whose
-- product already has 0 quantity (the application clamps quantity to >= 0
-- everywhere it is written) is moved to ON_HOLD immediately, matching what
-- upsertReviewListings would have set had it run for that product today.
--
-- No reverse direction is needed: ON_HOLD did not exist before V19, so there
-- is nothing already ON_HOLD to release back.

UPDATE marketplace_listings ml
SET listing_status = 'ON_HOLD',
    updated_at = NOW()
FROM products p
WHERE ml.product_id = p.id
  AND ml.listing_status = 'NEEDS_REVIEW'
  AND p.quantity <= 0;
