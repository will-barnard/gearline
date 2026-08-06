import type { Transaction } from 'kysely';

import { db } from '../db/index.js';
import type { Database, ProductRow } from '../db/types.js';
import { ApiError, ResourceNotFoundError } from '../http/errors.js';
import { loggerFor } from '../logger.js';
import { enqueue } from '../queue/sync-job-producer.js';

const log = loggerFor('product-exclusion');

/**
 * Port of ProductExclusionService.
 *
 * Excluding a product means "this must never appear on eBay or Reverb", used for
 * Shopify-only items such as deposit listings. Setting the flag has side effects
 * on existing listings, and the side effects differ by listing status:
 *
 *   ACTIVE      → live on a marketplace; queue a LISTING_DELIST job so it is
 *                 actually removed. Do NOT just delete the row, or the listing
 *                 stays up forever with nothing in Gearline tracking it.
 *   PENDING /
 *   NEEDS_REVIEW /
 *   FAILED /
 *   INACTIVE /
 *   DELISTED    → never published (or already off-market); delete the stub.
 *   PUBLISHING  → a publish is in flight. Mark FAILED and let the job error out.
 *   SOLD        → historical record of a real sale; leave it completely alone.
 *
 * Shopify listings are skipped entirely — Shopify is the product source, not a
 * listing destination.
 */

export async function setExcluded(productId: string, excluded: boolean): Promise<ProductRow> {
  return db.transaction().execute(async (trx) => {
    const product = await trx
      .selectFrom('products')
      .selectAll()
      .where('id', '=', productId)
      // Serialise concurrent exclusion toggles for the same product so the
      // side effects below cannot interleave and double-queue delist jobs.
      .forUpdate()
      .executeTakeFirst();

    if (!product) throw new ResourceNotFoundError('Product', productId);

    if (product.marketplace_excluded === excluded) {
      return product; // No change — skip the side effects entirely.
    }

    const updated = await trx
      .updateTable('products')
      .set({ marketplace_excluded: excluded, updated_at: new Date() })
      .where('id', '=', productId)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (excluded) {
      await applyExclusionSideEffects(trx, productId, product.sku);
    }

    log.info(
      { sku: product.sku, productId, excluded },
      'Product marketplace_excluded flag updated',
    );

    return updated;
  });
}

export async function bulkSetExcluded(productIds: string[], excluded: boolean): Promise<number> {
  if (productIds.length === 0) return 0;

  return db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('products')
      .set({ marketplace_excluded: excluded, updated_at: new Date() })
      .where('id', 'in', productIds)
      // Only touch rows actually changing, so the returned count reflects real
      // changes and unchanged products do not get pointless delist jobs.
      .where('marketplace_excluded', '=', !excluded)
      .returning(['id', 'sku'])
      .execute();

    if (excluded) {
      for (const p of updated) {
        await applyExclusionSideEffects(trx, p.id, p.sku);
      }
    }

    log.info({ excluded, count: updated.length }, 'Bulk marketplace_excluded applied');
    return updated.length;
  });
}

type Trx = Transaction<Database>;

async function applyExclusionSideEffects(trx: Trx, productId: string, sku: string): Promise<void> {
  const listings = await trx
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', productId)
    .execute();

  for (const listing of listings) {
    if (listing.marketplace_type === 'SHOPIFY') continue;

    switch (listing.listing_status) {
      case 'ACTIVE': {
        await enqueue(
          {
            jobType: 'LISTING_DELIST',
            marketplaceType: listing.marketplace_type,
            marketplaceAccountId: listing.marketplace_account_id,
            productId,
            listingId: listing.id,
            payload: { reason: 'marketplace_excluded' },
            idempotencyKey: `exclude-delist-${listing.id}`,
          },
          trx,
        );
        log.info(
          { marketplace: listing.marketplace_type, listingId: listing.id, sku },
          'Queued LISTING_DELIST for excluded product',
        );
        break;
      }

      case 'NEEDS_REVIEW':
      case 'PENDING':
      case 'FAILED':
      case 'INACTIVE':
      case 'DELISTED': {
        await trx.deleteFrom('marketplace_listings').where('id', '=', listing.id).execute();
        log.info(
          { marketplace: listing.marketplace_type, listingId: listing.id, status: listing.listing_status, sku },
          'Deleted listing stub for excluded product',
        );
        break;
      }

      case 'PUBLISHING': {
        await trx
          .updateTable('marketplace_listings')
          .set({
            listing_status: 'FAILED',
            last_error: 'Product excluded from marketplaces while publish was in progress.',
            updated_at: new Date(),
          })
          .where('id', '=', listing.id)
          .execute();
        log.warn({ sku, listingId: listing.id }, 'Product excluded mid-publish — listing marked FAILED');
        break;
      }

      case 'SOLD':
        // Completed sale. Historical record — leave it alone.
        break;

      default: {
        // Exhaustiveness guard: if a new ListingStatus is added to the enum and
        // this switch is not updated, fail loudly rather than silently skipping
        // cleanup and leaving a listing live on a marketplace.
        const unreachable: never = listing.listing_status;
        throw new ApiError(
          500,
          'Unhandled listing status',
          `No exclusion side effect defined for listing status: ${String(unreachable)}`,
        );
      }
    }
  }
}
