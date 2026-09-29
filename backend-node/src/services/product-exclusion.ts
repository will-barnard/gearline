import type { Transaction } from 'kysely';

import { db } from '../db/index.js';
import type { Database, MarketplaceType, ProductRow } from '../db/types.js';
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
 *   ON_HOLD /
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

/** Marketplace types a product can be excluded from. Shopify is the source, never a destination. */
export const EXCLUDABLE_MARKETPLACES: MarketplaceType[] = ['EBAY', 'REVERB', 'GEAR_EXCHANGE'];

/**
 * Replaces the set of marketplaces a product is kept off.
 *
 * Whole-set replacement rather than add/remove calls: the product screen shows
 * one checkbox per marketplace and sends the resulting set, so there is no
 * sequence of partial updates to get out of order.
 *
 * Newly excluded marketplaces get the same side effects as a full exclusion,
 * scoped to that marketplace — a live listing is delisted, review stubs are
 * removed. A marketplace REMOVED from the set gets nothing: its stubs come back
 * the next time a Shopify webhook touches the product, exactly as they do when
 * marketplace_excluded is cleared.
 */
export async function setExcludedMarketplaces(
  productId: string,
  marketplaces: MarketplaceType[],
): Promise<ProductRow> {
  const next = [...new Set(marketplaces)].filter((m) => EXCLUDABLE_MARKETPLACES.includes(m)).sort();

  return db.transaction().execute(async (trx) => {
    const product = await trx
      .selectFrom('products')
      .selectAll()
      .where('id', '=', productId)
      .forUpdate()
      .executeTakeFirst();

    if (!product) throw new ResourceNotFoundError('Product', productId);

    const previous = new Set(product.excluded_marketplaces ?? []);
    const added = next.filter((m) => !previous.has(m));
    const unchanged = next.length === previous.size && added.length === 0;

    if (unchanged) return product;

    const updated = await trx
      .updateTable('products')
      .set({ excluded_marketplaces: next, updated_at: new Date() })
      .where('id', '=', productId)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (added.length > 0) {
      await applyExclusionSideEffects(trx, productId, product.sku, added);
    }

    log.info(
      { sku: product.sku, productId, excludedMarketplaces: next, newlyExcluded: added },
      'Product per-marketplace exclusions updated',
    );

    return updated;
  });
}

type Trx = Transaction<Database>;

/**
 * `onlyTypes` scopes the side effects to particular marketplaces, for a
 * per-marketplace exclusion. Omitted, every marketplace is affected.
 */
async function applyExclusionSideEffects(
  trx: Trx,
  productId: string,
  sku: string,
  onlyTypes?: MarketplaceType[],
): Promise<void> {
  const listings = await trx
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', productId)
    .execute();

  for (const listing of listings) {
    if (listing.marketplace_type === 'SHOPIFY') continue;
    if (onlyTypes && !onlyTypes.includes(listing.marketplace_type)) continue;

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
            // Keyed on the listing's updated_at as well as its id. The id alone
            // suppressed the delist forever after the first one: exclude,
            // re-include, republish, exclude again — and the second delist was
            // silently deduplicated against the first, leaving the item live.
            idempotencyKey: `exclude-delist-${listing.id}-${listing.updated_at.getTime()}`,
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
      case 'ON_HOLD':
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
