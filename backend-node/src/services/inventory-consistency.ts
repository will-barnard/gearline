import type { Transaction } from 'kysely';

import { db, sql } from '../db/index.js';
import type { Database, MarketplaceAccountRow, ProductRow } from '../db/types.js';
import { OptimisticLockError } from '../http/errors.js';
import { loggerFor } from '../logger.js';
import type { ImportedOrder } from '../marketplace/types.js';
import { enqueue } from '../queue/sync-job-producer.js';

const log = loggerFor('inventory-consistency');

/**
 * Port of InventoryConsistencyService.
 *
 * Keeps quantity consistent across every connected channel so the shop cannot
 * oversell. When stock changes anywhere, the new figure is propagated to all
 * other active listings.
 *
 * ── Zero-quantity behaviour ──────────────────────────────────────────────────
 *
 * Reaching 0 does NOT push a quantity update — it enqueues LISTING_DELIST. A
 * marketplace listing sitting at 0 stock stays visible and can still take an
 * order on some platforms; removing it is the only safe outcome.
 *
 * ── Shopify is always skipped ────────────────────────────────────────────────
 *
 * Shopify is the product source, not a listing destination. Its inventory is
 * managed through the webhook path, and ShopifyConnector.syncInventory is a
 * deliberate no-op. Propagating to it would fight the webhook and could ping-pong.
 *
 * ── Optimistic locking, without JPA ─────────────────────────────────────────
 *
 * Java relied on @Version plus @Retryable(ObjectOptimisticLockingFailureException).
 * There is no ORM here, so the version check is written explicitly as a
 * predicate on the UPDATE and the retry loop is written by hand. The behaviour
 * is the same: three attempts, 100ms base, doubling.
 */

const MAX_LOCK_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Trx = Transaction<Database>;

/**
 * Writes the new quantity and fans out sync jobs to the other channels.
 *
 * The UPDATE carries `WHERE version = :expected` and bumps the version. If it
 * matches no rows another writer got there first, and we retry with a freshly
 * read product — which is what prevents two concurrent orders for the last item
 * from both deciding stock is 1.
 */
export async function propagateInventoryChange(
  productId: string,
  newQuantity: number,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      await attemptPropagate(productId, newQuantity);
      return;
    } catch (err) {
      if (!(err instanceof OptimisticLockError) || attempt === MAX_LOCK_ATTEMPTS) throw err;

      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      log.warn({ productId, attempt, delay }, 'Optimistic lock conflict — retrying');
      await sleep(delay);
    }
  }
}

async function attemptPropagate(productId: string, newQuantity: number): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const product = await trx
      .selectFrom('products')
      .selectAll()
      .where('id', '=', productId)
      .executeTakeFirst();

    if (!product) {
      log.warn({ productId }, 'Product not found — skipping inventory propagation');
      return;
    }

    const updated = await trx
      .updateTable('products')
      .set({
        quantity: newQuantity,
        version: sql<string>`version + 1`,
        updated_at: new Date(),
      })
      .where('id', '=', productId)
      .where('version', '=', product.version)
      .returningAll()
      .executeTakeFirst();

    if (!updated) throw new OptimisticLockError();

    log.info(
      { sku: product.sku, from: product.quantity, to: newQuantity },
      'Propagating inventory change',
    );

    await fanOutInventoryJobs(trx, updated, newQuantity);
  });
}

/**
 * Enqueues the per-channel jobs.
 *
 * ── Idempotency keys ─────────────────────────────────────────────────────────
 *
 * Keys embed the product's NEW version, so:
 *   - the same inventory event delivered twice produces the same key and the
 *     second is suppressed by the unique constraint;
 *   - a subsequent genuine change bumps the version and produces a new key.
 *
 * The original Java used System.currentTimeMillis() here, which made every key
 * unique and defeated the entire mechanism. The version-based key is the fix,
 * and it only works because the UPDATE above increments version exactly once
 * per real change.
 */
async function fanOutInventoryJobs(
  trx: Trx,
  product: ProductRow,
  newQuantity: number,
): Promise<void> {
  const activeListings = await trx
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', product.id)
    .where('listing_status', '=', 'ACTIVE')
    .execute();

  const version = product.version ?? '0';

  if (newQuantity === 0) {
    log.info(
      { sku: product.sku, channels: activeListings.length },
      'Quantity reached 0 — delisting from active channels',
    );
  }

  for (const listing of activeListings) {
    if (listing.marketplace_type === 'SHOPIFY') {
      log.debug({ listingId: listing.id }, 'Skipping Shopify listing (managed via webhook path)');
      continue;
    }

    if (newQuantity === 0) {
      await enqueue(
        {
          jobType: 'LISTING_DELIST',
          marketplaceType: listing.marketplace_type,
          marketplaceAccountId: listing.marketplace_account_id,
          productId: product.id,
          listingId: listing.id,
          payload: {},
          idempotencyKey: `delist-soldout-${listing.id}-v${version}`,
        },
        trx,
      );

      log.info(
        { marketplace: listing.marketplace_type, listingId: listing.id, sku: product.sku },
        'Enqueued LISTING_DELIST (sold out)',
      );
    } else {
      await enqueue(
        {
          jobType: 'INVENTORY_SYNC',
          marketplaceType: listing.marketplace_type,
          marketplaceAccountId: listing.marketplace_account_id,
          productId: product.id,
          listingId: listing.id,
          payload: { newQuantity },
          idempotencyKey: `inv-${product.id}-${listing.id}-v${version}`,
        },
        trx,
      );
    }
  }
}

/**
 * Deducts sold quantity when an order is imported, then propagates.
 *
 * Line items are matched by productId first, falling back to SKU. An unmatched
 * SKU is logged and skipped rather than failing the import — the order is real
 * and must be recorded even if we cannot map it to a catalogue item.
 */
export async function handleOrderImported(
  importedOrder: ImportedOrder,
  sourceAccount: MarketplaceAccountRow,
): Promise<void> {
  for (const lineItem of importedOrder.lineItems) {
    let product: ProductRow | undefined;

    if (lineItem.productId) {
      product = await db
        .selectFrom('products')
        .selectAll()
        .where('id', '=', lineItem.productId)
        .executeTakeFirst();
    } else if (lineItem.sku && lineItem.sku.trim() !== '') {
      product = await db
        .selectFrom('products')
        .selectAll()
        .where('sku', '=', lineItem.sku)
        .executeTakeFirst();

      if (!product) {
        log.warn(
          { sku: lineItem.sku, marketplace: sourceAccount.marketplace_type },
          'Order imported but no product matches SKU — inventory not adjusted',
        );
      }
    }

    if (!product) continue;

    const soldQuantity = lineItem.quantity ?? 1;
    // Clamp at zero: a marketplace can report a sale larger than our stock if
    // we were already out of sync, and a negative quantity violates the CHECK
    // constraint on the products table.
    const newQuantity = Math.max(0, product.quantity - soldQuantity);

    log.info(
      {
        sku: product.sku,
        from: product.quantity,
        to: newQuantity,
        marketplace: sourceAccount.marketplace_type,
      },
      'Order imported — reducing quantity',
    );

    await propagateInventoryChange(product.id, newQuantity);
  }
}
