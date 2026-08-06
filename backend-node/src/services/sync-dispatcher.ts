import { db, sql } from '../db/index.js';
import { toJson } from '../db/json.js';
import type { MarketplaceListingRow, SyncJobRow } from '../db/types.js';
import { loggerFor } from '../logger.js';
import { getConnector } from '../marketplace/registry.js';
import type { PublishListingRequest } from '../marketplace/types.js';
import { applyPercentageAdjustment } from '../util/decimal.js';
import { resolve } from './listing-attribute-resolver.js';
import { importOrder } from './order-import.js';

const log = loggerFor('sync-dispatcher');

/**
 * Port of SyncDispatcherService — routes a sync job to the right connector call.
 *
 * ── Transaction boundary, deliberately absent ────────────────────────────────
 *
 * The Java dispatch() was @Transactional. That is NOT reproduced, and the
 * omission is intentional.
 *
 * A publish job makes a network call to eBay or Reverb that can take seconds.
 * Holding a database transaction open across it pins a connection for the whole
 * duration and, worse, means a post-call failure rolls back the record of a
 * listing that now genuinely exists on the marketplace — leaving an orphaned
 * live listing with no external ID stored.
 *
 * Instead each state write is its own short statement, executed after the
 * network call returns. The external system is the thing we cannot roll back,
 * so the database is made to follow it rather than the reverse.
 */

export async function dispatch(job: SyncJobRow): Promise<void> {
  switch (job.job_type) {
    case 'LISTING_PUBLISH':
      return publishListing(job);
    case 'LISTING_UPDATE':
      return updateListing(job);
    case 'LISTING_DELIST':
      return delistListing(job);
    case 'INVENTORY_SYNC':
      return syncInventory(job);
    case 'ORDER_IMPORT':
      return importSingleOrder(job);
    default:
      log.warn({ jobType: job.job_type, jobId: job.id }, 'No handler for sync job type');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function requireAccount(id: string | null) {
  if (!id) throw new Error('Sync job has no marketplaceAccountId');
  const account = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!account) throw new Error(`MarketplaceAccount not found: ${id}`);
  return account;
}

async function requireProduct(id: string | null) {
  if (!id) throw new Error('Sync job has no productId');
  const product = await db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!product) throw new Error(`Product not found: ${id}`);
  return product;
}

async function requireListing(id: string | null) {
  if (!id) throw new Error('Sync job has no listingId');
  const listing = await db
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!listing) throw new Error(`MarketplaceListing not found: ${id}`);
  return listing;
}

/**
 * Applies the account's pricing profile.
 *
 * Precedence, unchanged from Java:
 *   1. An explicit per-listing price override always wins — the operator set it
 *      by hand and a profile must not silently move it.
 *   2. No profile assigned, or profile inactive → unchanged.
 *   3. Otherwise price × (1 + adjustmentPercent/100), HALF_UP to 2dp.
 */
async function applyPricingProfile(
  request: PublishListingRequest,
  productPrice: string,
  pricingProfileId: string | null,
): Promise<PublishListingRequest> {
  if (request.priceOverride !== null) return request;
  if (!pricingProfileId) return request;

  const profile = await db
    .selectFrom('pricing_profiles')
    .selectAll()
    .where('id', '=', pricingProfileId)
    .executeTakeFirst();

  if (!profile || !profile.active) return request;

  const adjusted = applyPercentageAdjustment(productPrice, profile.adjustment_percent);

  log.debug(
    { profile: profile.name, percent: profile.adjustment_percent, from: productPrice, to: adjusted },
    'Applied pricing profile',
  );

  return { ...request, priceOverride: adjusted };
}

// ── Job handlers ─────────────────────────────────────────────────────────────

async function publishListing(job: SyncJobRow): Promise<void> {
  const [account, product] = await Promise.all([
    requireAccount(job.marketplace_account_id),
    requireProduct(job.product_id),
  ]);
  const connector = getConnector(account.marketplace_type);

  // Find the existing listing, or build a transient shell so the resolver has
  // somewhere to read overrides from. A brand-new listing has empty overrides
  // and every attribute falls back to the product.
  const existing = await db
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', product.id)
    .where('marketplace_account_id', '=', account.id)
    .executeTakeFirst();

  const shell = existing ?? {
    listing_overrides: {},
    marketplace_type: account.marketplace_type,
  };

  let request = resolve(product, shell, account);
  request = await applyPricingProfile(request, product.price, account.pricing_profile_id);

  const result = await connector.publishListing(account, product, request);

  if (result.success) {
    // Insurance value is folded into metadata so it stays auditable in the UI
    // alongside whatever the marketplace returned.
    const metadata: Record<string, unknown> = { ...result.rawMetadata };
    if (request.shippingDetails?.insuranceValueUsd) {
      metadata['insurance_value_usd'] = request.shippingDetails.insuranceValueUsd;
    }

    await upsertListing(existing, {
      productId: product.id,
      accountId: account.id,
      marketplaceType: account.marketplace_type,
      externalListingId: result.externalListingId,
      status: 'ACTIVE',
      syncedPrice: result.publishedPrice,
      syncedQuantity: result.publishedQuantity,
      metadata,
    });
  } else {
    await recordListingFailure(existing, product.id, account, result.errorMessage);
  }
}

async function updateListing(job: SyncJobRow): Promise<void> {
  const [account, product, listing] = await Promise.all([
    requireAccount(job.marketplace_account_id),
    requireProduct(job.product_id),
    requireListing(job.listing_id),
  ]);
  const connector = getConnector(account.marketplace_type);

  // Re-resolve on every update so newly-set overrides are picked up.
  let request = resolve(product, listing, account);
  request = await applyPricingProfile(request, product.price, account.pricing_profile_id);

  const result = await connector.updateListing(account, product, listing, request);

  if (result.success) {
    await db
      .updateTable('marketplace_listings')
      .set({
        listing_status: 'ACTIVE',
        synced_price: result.publishedPrice,
        synced_quantity: result.publishedQuantity,
        last_sync_at: new Date(),
        last_error: null,
        updated_at: new Date(),
      })
      .where('id', '=', listing.id)
      .execute();
  } else {
    await markListingFailed(listing.id, result.errorMessage);
  }
}

async function delistListing(job: SyncJobRow): Promise<void> {
  const [account, listing] = await Promise.all([
    requireAccount(job.marketplace_account_id),
    requireListing(job.listing_id),
  ]);
  const connector = getConnector(account.marketplace_type);

  await connector.delistListing(account, listing);

  await db
    .updateTable('marketplace_listings')
    .set({
      listing_status: 'DELISTED',
      last_sync_at: new Date(),
      last_error: null,
      updated_at: new Date(),
    })
    .where('id', '=', listing.id)
    .execute();
}

async function syncInventory(job: SyncJobRow): Promise<void> {
  const [account, listing, product] = await Promise.all([
    requireAccount(job.marketplace_account_id),
    requireListing(job.listing_id),
    requireProduct(job.product_id),
  ]);
  const connector = getConnector(account.marketplace_type);

  const result = await connector.syncInventory(account, listing, product.quantity);

  if (result.success) {
    await db
      .updateTable('marketplace_listings')
      .set({
        synced_quantity: result.quantitySynced,
        last_sync_at: new Date(),
        last_error: null,
        updated_at: new Date(),
      })
      .where('id', '=', listing.id)
      .execute();
  } else {
    // Note: unlike publish/update, an inventory failure does NOT flip the
    // listing to FAILED. The listing is still live and correct apart from its
    // quantity; marking it FAILED would misrepresent its state in the UI.
    await db
      .updateTable('marketplace_listings')
      .set({
        last_error: result.errorMessage,
        error_count: listing.error_count + 1,
        updated_at: new Date(),
      })
      .where('id', '=', listing.id)
      .execute();
  }
}

async function importSingleOrder(job: SyncJobRow): Promise<void> {
  const account = await requireAccount(job.marketplace_account_id);
  const connector = getConnector(account.marketplace_type);

  // String() rather than a cast: JSON round-tripping can turn a numeric order
  // ID into a number, and a bare cast would blow up at runtime.
  const raw = job.payload?.['externalOrderId'];
  const externalOrderId = raw === null || raw === undefined ? null : String(raw);

  if (!externalOrderId || externalOrderId.trim() === '') {
    log.error({ jobId: job.id }, 'ORDER_IMPORT job has no externalOrderId in payload — skipping');
    return;
  }

  const imported = await connector.importOrder(account, externalOrderId);

  if (!imported) {
    log.warn(
      { externalOrderId, marketplace: account.marketplace_type, accountId: account.id },
      'Connector returned null for order — skipping import',
    );
    return;
  }

  await importOrder(imported, account);
}

/**
 * Called by the consumer when a LISTING_DELIST job is dead-lettered.
 *
 * A delist that exhausted every retry leaves the listing ACTIVE in our database
 * while its true state on the marketplace is unknown. Marking it FAILED is what
 * tells the operator manual intervention is needed — otherwise the item looks
 * healthy while potentially still being for sale.
 */
export async function markDelistFailed(job: SyncJobRow): Promise<void> {
  if (!job.listing_id) return;

  const updated = await db
    .updateTable('marketplace_listings')
    .set({
      listing_status: 'FAILED',
      last_error: `Delist failed after ${job.retry_count} attempts: ${job.failure_reason ?? 'unknown'}`,
      updated_at: new Date(),
    })
    .where('id', '=', job.listing_id)
    .where('listing_status', '=', 'ACTIVE')
    .returning('id')
    .executeTakeFirst();

  if (updated) {
    log.warn(
      { listingId: job.listing_id, jobId: job.id },
      'Listing marked FAILED after LISTING_DELIST was dead-lettered',
    );
  }
}

// ── Listing persistence helpers ──────────────────────────────────────────────

interface UpsertArgs {
  productId: string;
  accountId: string;
  marketplaceType: MarketplaceListingRow['marketplace_type'];
  externalListingId: string | null;
  status: MarketplaceListingRow['listing_status'];
  syncedPrice: string | null;
  syncedQuantity: number | null;
  metadata: Record<string, unknown>;
}

async function upsertListing(
  existing: MarketplaceListingRow | undefined,
  args: UpsertArgs,
): Promise<void> {
  if (existing) {
    await db
      .updateTable('marketplace_listings')
      .set({
        external_listing_id: args.externalListingId,
        listing_status: args.status,
        synced_price: args.syncedPrice,
        synced_quantity: args.syncedQuantity,
        last_sync_at: new Date(),
        last_error: null,
        marketplace_metadata: toJson(args.metadata),
        updated_at: new Date(),
      })
      .where('id', '=', existing.id)
      .execute();
    return;
  }

  await db
    .insertInto('marketplace_listings')
    .values({
      product_id: args.productId,
      marketplace_account_id: args.accountId,
      marketplace_type: args.marketplaceType,
      external_listing_id: args.externalListingId,
      listing_status: args.status,
      synced_price: args.syncedPrice,
      synced_quantity: args.syncedQuantity,
      last_sync_at: new Date(),
      listing_overrides: toJson({}),
      marketplace_metadata: toJson(args.metadata),
    })
    // uq_listing_product_account: a concurrent publish may have created the row
    // between our SELECT and here. Update it rather than losing the external ID
    // we just obtained from the marketplace.
    .onConflict((oc) =>
      oc.columns(['product_id', 'marketplace_account_id']).doUpdateSet({
        external_listing_id: args.externalListingId,
        listing_status: args.status,
        synced_price: args.syncedPrice,
        synced_quantity: args.syncedQuantity,
        last_sync_at: new Date(),
        marketplace_metadata: toJson(args.metadata),
        updated_at: new Date(),
      }),
    )
    .execute();
}

async function recordListingFailure(
  existing: MarketplaceListingRow | undefined,
  productId: string,
  account: { id: string; marketplace_type: MarketplaceListingRow['marketplace_type'] },
  errorMessage: string | null,
): Promise<void> {
  if (existing) {
    await markListingFailed(existing.id, errorMessage);
    return;
  }

  await db
    .insertInto('marketplace_listings')
    .values({
      product_id: productId,
      marketplace_account_id: account.id,
      marketplace_type: account.marketplace_type,
      listing_status: 'FAILED',
      last_error: errorMessage,
      error_count: 1,
      listing_overrides: toJson({}),
      marketplace_metadata: toJson({}),
    })
    .onConflict((oc) =>
      oc.columns(['product_id', 'marketplace_account_id']).doUpdateSet({
        listing_status: 'FAILED',
        last_error: errorMessage,
        updated_at: new Date(),
      }),
    )
    .execute();
}

async function markListingFailed(listingId: string, errorMessage: string | null): Promise<void> {
  await db
    .updateTable('marketplace_listings')
    .set({
      listing_status: 'FAILED',
      last_error: errorMessage,
      // Incremented in SQL, not read-modify-write. Two failures landing at once
      // would otherwise both read the same count and record only one.
      error_count: sql<number>`error_count + 1`,
      updated_at: new Date(),
    })
    .where('id', '=', listingId)
    .execute();
}
