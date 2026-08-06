import { db } from '../db/index.js';
import { toJson } from '../db/json.js';
import type { MarketplaceAccountRow } from '../db/types.js';
import { loggerFor } from '../logger.js';

const log = loggerFor('listing-backfill');

const PAGE_SIZE = 100;

/**
 * Creates NEEDS_REVIEW listing stubs for existing products when a new
 * marketplace account is connected. Port of ListingBackfillService.
 *
 * Without this, products imported from Shopify before the account existed would
 * have no listing row for it, and would only appear once a Shopify webhook
 * happened to fire for each one — which for a static catalogue could be never.
 *
 * Eligibility matches ProductRepository.findAvailableForListing exactly:
 *   status = ACTIVE AND quantity > 0 AND marketplace_excluded = false
 *
 * Those criteria are the same ones the webhook processor uses, so a product
 * backfilled here and one created by a webhook end up in identical states.
 */
export async function backfillListingsForNewAccount(
  account: MarketplaceAccountRow,
): Promise<void> {
  log.info(
    { marketplace: account.marketplace_type, accountId: account.id },
    'Backfilling NEEDS_REVIEW listings for new account',
  );

  let offset = 0;
  let created = 0;
  let skipped = 0;

  for (;;) {
    const products = await db
      .selectFrom('products')
      .select('id')
      .where('status', '=', 'ACTIVE')
      .where('quantity', '>', 0)
      .where('marketplace_excluded', '=', false)
      // Stable ordering so paging cannot skip or repeat rows if the catalogue
      // changes mid-backfill.
      .orderBy('id', 'asc')
      .limit(PAGE_SIZE)
      .offset(offset)
      .execute();

    if (products.length === 0) break;

    for (const product of products) {
      /**
       * ON CONFLICT rather than a check-then-insert. The unique constraint on
       * (product_id, marketplace_account_id) is the real guard, and a
       * concurrent Shopify webhook creating the same stub is entirely likely
       * during a backfill of a large catalogue.
       */
      const inserted = await db
        .insertInto('marketplace_listings')
        .values({
          product_id: product.id,
          marketplace_account_id: account.id,
          marketplace_type: account.marketplace_type,
          listing_status: 'NEEDS_REVIEW',
          listing_overrides: toJson({}),
          marketplace_metadata: toJson({}),
        })
        .onConflict((oc) => oc.columns(['product_id', 'marketplace_account_id']).doNothing())
        .returning('id')
        .executeTakeFirst();

      if (inserted) created++;
      else skipped++;
    }

    if (products.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  log.info(
    { marketplace: account.marketplace_type, accountId: account.id, created, skipped },
    'Backfill complete',
  );
}
