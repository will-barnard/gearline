import { db } from '../db/index.js';
import type { MarketplaceListingRow, ProductRow } from '../db/types.js';
import { ConflictError, ResourceNotFoundError } from '../http/errors.js';
import { loggerFor } from '../logger.js';
import { enqueue } from '../queue/sync-job-producer.js';
import { channelQuantity } from './special-order.js';
import * as shopify from '../marketplace/shopify/client.js';
import { upsertReviewListings } from '../marketplace/shopify/webhook-processor.js';

const log = loggerFor('product-archive');

/**
 * Archiving and un-archiving a product by hand.
 *
 * ── Why archive lives here and not in the route ──────────────────────────────
 *
 * The Products page asks "This will delist it from any active marketplaces",
 * but the route used to only flip products.status — a live eBay/Reverb listing
 * stayed up with nothing in Gearline tracking it. The Shopify-driven archive
 * (archiveAndDelist in webhook-processor) always queued the delists; the manual
 * one now does too, so the two paths mean the same thing and un-archive has a
 * known starting point to restore from.
 *
 * ── Un-archive is the mirror of what a Shopify "draft → active" does ─────────
 *
 * It does NOT republish anything. It makes the product ACTIVE again and puts its
 * listings back in the review queue (NEEDS_REVIEW, or ON_HOLD at zero stock) via
 * the same upsertReviewListings the webhooks use — same eligibility rules, same
 * stale-external-id reset. The operator then publishes from the Listings page,
 * so the "I want to list it again" step stays a deliberate click.
 */

/** Jobs that will still take a listing off a marketplace (or retry doing so). */
const PENDING_JOB_STATUSES = ['QUEUED', 'IN_PROGRESS', 'FAILED'] as const;

export async function archiveProduct(productId: string): Promise<void> {
  const product = await db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!product) throw new ResourceNotFoundError('Product', productId);

  await db
    .updateTable('products')
    .set({ status: 'ARCHIVED', updated_at: new Date() })
    .where('id', '=', productId)
    .execute();

  const live = await db
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', productId)
    .where('listing_status', '=', 'ACTIVE')
    .execute();

  for (const listing of live) {
    if (listing.marketplace_type === 'SHOPIFY') continue;

    await enqueue({
      jobType: 'LISTING_DELIST',
      marketplaceType: listing.marketplace_type,
      marketplaceAccountId: listing.marketplace_account_id,
      productId,
      listingId: listing.id,
      payload: { reason: 'product_archived' },
      // updated_at in the key for the same reason as exclusion: archive,
      // un-archive, republish, archive again must not be deduplicated against
      // the first delist and leave the item live.
      idempotencyKey: `archive-delist-${listing.id}-${listing.updated_at.getTime()}`,
    });

    log.info(
      { marketplace: listing.marketplace_type, listingId: listing.id, sku: product.sku },
      'Queued LISTING_DELIST for archived product',
    );
  }
}

export interface UnarchiveResult {
  product: ProductRow;
  listings: MarketplaceListingRow[];
  /** Operator-facing heads-ups; none of them block the un-archive. */
  warnings: string[];
}

export async function unarchiveProduct(productId: string): Promise<UnarchiveResult> {
  const product = await db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!product) throw new ResourceNotFoundError('Product', productId);

  if (product.status !== 'ARCHIVED') {
    throw new ConflictError(`Product is ${product.status}, not ARCHIVED — nothing to un-archive`);
  }

  /**
   * A delist queued by the archive may not have run yet. If we reset the
   * listing now it still reads ACTIVE ("live — leave alone"), the delist then
   * lands, and the listing ends up DELISTED with nothing to bring it back until
   * the next Shopify webhook. Refusing is cheaper than that stuck state.
   */
  const pending = await db
    .selectFrom('sync_jobs')
    .select('id')
    .where('product_id', '=', productId)
    .where('job_type', '=', 'LISTING_DELIST')
    .where('status', 'in', [...PENDING_JOB_STATUSES])
    .executeTakeFirst();

  if (pending) {
    throw new ConflictError(
      'A delist from a marketplace is still in progress for this product. Wait for it to finish, then un-archive.',
    );
  }

  const warnings = await shopifyStatusWarnings(product);

  const updated = await db
    .updateTable('products')
    .set({ status: 'ACTIVE', updated_at: new Date() })
    .where('id', '=', productId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await upsertReviewListings(updated);

  const listings = await db
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', productId)
    .execute();

  if (updated.marketplace_excluded) {
    warnings.push('This product is excluded from all marketplaces, so no listings were restored.');
  } else if (channelQuantity(updated) <= 0) {
    warnings.push('Quantity is 0 — listings are on hold until stock is back.');
  }

  log.info({ sku: updated.sku, productId, listings: listings.length }, 'Product un-archived');

  return { product: updated, listings, warnings };
}

/**
 * Shopify is the source of truth: if the product is still draft/archived there,
 * its next products/update webhook archives it here again and delists
 * everything. Worth saying before the operator publishes.
 *
 * Best-effort — a Shopify outage must not block un-archiving, so any failure
 * yields no warning rather than an error.
 */
async function shopifyStatusWarnings(product: ProductRow): Promise<string[]> {
  if (!product.shopify_product_id) return [];

  try {
    const account = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('marketplace_type', '=', 'SHOPIFY')
      .where('active', '=', true)
      .executeTakeFirst();

    if (!account) return [];

    const remote = await shopify.fetchProduct(account, product.shopify_product_id);
    const status = typeof remote?.['status'] === 'string' ? remote['status'] : null;

    if (status && status !== 'active') {
      return [
        `This product is "${status}" in Shopify. Set it to Active there too, or the next Shopify update will archive it here again.`,
      ];
    }
  } catch (err) {
    log.warn({ err, productId: product.id }, 'Could not check Shopify status during un-archive');
  }

  return [];
}
