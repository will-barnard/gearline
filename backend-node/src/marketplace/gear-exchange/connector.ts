import { db } from '../../db/index.js';
import type { MarketplaceAccountRow, MarketplaceListingRow, ProductRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { enqueue } from '../../queue/sync-job-producer.js';
import {
  healthy,
  inventoryFailure,
  inventorySuccess,
  PermanentMarketplaceError,
  publishFailure,
  publishSuccess,
  unhealthy,
  type ConnectorHealthResult,
  type ImportedOrder,
  type InventorySyncResult,
  type MarketplaceConnector,
  type PublishListingRequest,
  type PublishListingResult,
} from '../types.js';
import { gearExchangeAuthProvider } from './auth-provider.js';
import * as client from './client.js';
import { conditionFor, toGxRequest } from './listing-mapper.js';
import { gearlineProductId, isDeadOrder, toImportedOrder } from './order-mapper.js';
import { configuredCategoryFor, resolveCategoryId, resolveConditionId } from './reference.js';
import type { GxListingDto, GxOrderDto } from './types.js';

const log = loggerFor('gx-connector');

/**
 * Sweetwater Gear Exchange connector.
 *
 * ── The one thing that makes GX different: one listing = one unit ───────────
 *
 * Reverb and eBay listings have a quantity. Gear Exchange listings do not —
 * each is a single item, and once it sells it is `sold` forever: it cannot be
 * edited, relisted or deleted. Gearline models one listing row per product per
 * account, so for a variant with 3 in stock the row points at ONE live GX
 * listing at a time, and a sale is followed by a NEW GX listing for the next
 * unit ("relisting").
 *
 * How that plays out through the existing machinery, without changing it:
 *
 *   1. A GX order is imported (poll or webhook). Inventory deduction then fans
 *      out to every ACTIVE listing — including this one.
 *   2. Stock left > 0 → INVENTORY_SYNC reaches syncInventory here, which sees
 *      the GX listing is `sold` and enqueues a LISTING_PUBLISH for the same row.
 *      Stock 0 → LISTING_DELIST, which is a no-op on a sold listing.
 *   3. publishListing sees the row's current GX listing is sold, creates a new
 *      one, and the dispatcher records the new external ID.
 *
 * The sold GX listing IDs are kept in marketplace_metadata.gx_previous_listing_ids
 * so an order for an earlier unit can still be traced to its product.
 *
 * ── Error contract ───────────────────────────────────────────────────────────
 *
 * As the other connectors: permanent rejections become failure results the
 * operator can read; retryable errors (429, 5xx, network, and GX's
 * image-processing lock — see client.ts) propagate to the retry ladder.
 * delist rethrows everything, because a delist that silently "succeeds" leaves
 * an item for sale with no stock behind it.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function externalIdOf(listing: MarketplaceListingRow): string {
  if (!listing.external_listing_id) {
    throw new PermanentMarketplaceError(
      `Gear Exchange listing ${listing.id} has no external_listing_id — it was never published`,
    );
  }
  return listing.external_listing_id;
}

function idOf(dto: GxListingDto): string | null {
  return dto.id === undefined || dto.id === null || String(dto.id).trim() === '' ? null : String(dto.id);
}

function statusOf(dto: GxListingDto | null): string {
  return String(dto?.status ?? '').toLowerCase();
}

/** Live on GX, or about to be once an admin reviews it. */
function isLive(dto: GxListingDto | null): boolean {
  const s = statusOf(dto);
  return s === 'published' || s === 'pending_admin_review';
}

function previousIds(listing: Pick<MarketplaceListingRow, 'marketplace_metadata'> | undefined): string[] {
  const raw = listing?.marketplace_metadata?.['gx_previous_listing_ids'];
  return Array.isArray(raw) ? raw.map((v) => String(v)) : [];
}

function buildMetadata(dto: GxListingDto, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const id = idOf(dto);
  return {
    gx_listing_id: id,
    gx_status: dto.status ?? null,
    // No listing URL is recorded: the API returns none, and a guessed URL
    // pattern that later 404s is worse than no link.
    ...extra,
  };
}

/**
 * Turns a GX 422 body into a readable sentence.
 *
 * GX answers validation failures with `{ message, errors: { field: [msgs] } }`.
 * The generic HTTP error message carries a truncated raw body, which is fine in
 * a log and useless on a listing card.
 */
export function explainError(err: PermanentMarketplaceError): string {
  if (err.responseBody) {
    try {
      const parsed = JSON.parse(err.responseBody) as { message?: unknown; errors?: unknown };
      const errors = parsed.errors;
      if (errors && typeof errors === 'object') {
        const messages = Object.values(errors as Record<string, unknown>)
          .flatMap((v) => (Array.isArray(v) ? v : [v]))
          .map((v) => String(v))
          .filter((v) => v.trim() !== '');
        if (messages.length > 0) return `Gear Exchange rejected the listing: ${messages.join(' ')}`;
      }
      if (typeof parsed.message === 'string' && parsed.message.trim() !== '') {
        return `Gear Exchange: ${parsed.message}`;
      }
    } catch {
      // Not JSON — fall through to the raw message.
    }
  }
  return err.message;
}

/**
 * Whether a newly created listing should go live straight away. Defaults to
 * TRUE, matching Reverb: "publish to Gear Exchange" should mean live, not a
 * draft that needs a second trip to Sweetwater's site.
 */
function shouldPublishImmediately(account: MarketplaceAccountRow): boolean {
  const raw = account.sync_settings?.['gx_publish_immediately'];
  return raw !== false && raw !== 'false';
}

async function buildBody(
  account: MarketplaceAccountRow,
  product: ProductRow,
  request: PublishListingRequest,
  publishImmediately?: boolean,
): Promise<Record<string, unknown>> {
  const configuredCategory = configuredCategoryFor(account, product, request.categoryId);

  if (!configuredCategory) {
    throw new PermanentMarketplaceError(
      `No Gear Exchange category configured for product type "${product.category ?? '(none)'}". ` +
        'Map it in the Gear Exchange account settings, set a fallback category there, ' +
        "or set category_id on this listing's overrides.",
    );
  }

  const [categoryId, conditionId] = await Promise.all([
    resolveCategoryId(account, configuredCategory),
    resolveConditionId(account, conditionFor(product, request, account)),
  ]);

  return toGxRequest(product, request, account, { categoryId, conditionId, publishImmediately });
}

async function findListingRow(
  productId: string,
  accountId: string,
): Promise<MarketplaceListingRow | undefined> {
  return db
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', productId)
    .where('marketplace_account_id', '=', accountId)
    .executeTakeFirst();
}

/**
 * Queues a publish for the NEXT unit after this row's GX listing sold.
 *
 * Idempotent per sold listing: the order import and the inventory sync can both
 * notice the same sale, and only one new listing may come of it.
 */
async function enqueueRelist(listing: MarketplaceListingRow, soldGxId: string): Promise<void> {
  await enqueue({
    jobType: 'LISTING_PUBLISH',
    marketplaceType: 'GEAR_EXCHANGE',
    marketplaceAccountId: listing.marketplace_account_id,
    productId: listing.product_id,
    listingId: listing.id,
    payload: { reason: 'gx_relist_after_sale', soldListingId: soldGxId },
    idempotencyKey: `gx-relist-${listing.id}-${soldGxId}`,
  });

  log.info(
    { listingId: listing.id, soldGxId },
    'Gear Exchange listing sold with stock remaining — queued a new listing for the next unit',
  );
}

/**
 * Maps a GX order to the Gearline product it sold.
 *
 * 1. productId on the order is our product UUID (set on every listing we make).
 * 2. Failing that — a listing created by hand, or productId lost — the GX
 *    listing ID is matched against current and previous external IDs.
 */
async function resolveProduct(
  account: MarketplaceAccountRow,
  dto: GxOrderDto,
): Promise<{ productId: string | null; sku: string | null; title: string | null }> {
  const uuid = gearlineProductId(dto);

  if (uuid) {
    const product = await db
      .selectFrom('products')
      .select(['id', 'sku', 'title'])
      .where('id', '=', uuid)
      .executeTakeFirst();
    if (product) return { productId: product.id, sku: product.sku, title: product.title };
  }

  const gxListingId = dto.listingId === undefined || dto.listingId === null ? null : String(dto.listingId);

  if (gxListingId) {
    const rows = await db
      .selectFrom('marketplace_listings')
      .select(['product_id', 'external_listing_id', 'marketplace_metadata'])
      .where('marketplace_account_id', '=', account.id)
      .execute();

    const row = rows.find(
      (r) => r.external_listing_id === gxListingId || previousIds(r).includes(gxListingId),
    );

    if (row) {
      const product = await db
        .selectFrom('products')
        .select(['id', 'sku', 'title'])
        .where('id', '=', row.product_id)
        .executeTakeFirst();
      if (product) return { productId: product.id, sku: product.sku, title: product.title };
    }
  }

  log.warn(
    { orderId: dto.orderId, gxListingId, productId: dto.productId },
    'Gear Exchange order could not be matched to a Gearline product — inventory will not be adjusted',
  );
  return { productId: null, sku: null, title: null };
}

/**
 * GX documents updatedStartTime as a bare local datetime ("2024-11-01T00:00:00")
 * without saying which timezone it is read in. Sweetwater is in Indiana
 * (US Eastern), so the window is widened by six hours to cover either reading.
 * Over-fetching is harmless — orders are deduplicated on import.
 */
const TIMEZONE_PAD_MS = 6 * 3_600_000;

function gxDateTime(date: Date): string {
  return date.toISOString().slice(0, 19);
}

// ── Connector ────────────────────────────────────────────────────────────────

export const gearExchangeConnector: MarketplaceConnector = {
  marketplaceType: 'GEAR_EXCHANGE',

  authProvider: gearExchangeAuthProvider,

  async checkHealth(account: MarketplaceAccountRow): Promise<ConnectorHealthResult> {
    try {
      return (await client.health(account))
        ? healthy('GEAR_EXCHANGE')
        : unhealthy('GEAR_EXCHANGE', 'Gear Exchange health endpoint did not report Ok');
    } catch (err) {
      return unhealthy('GEAR_EXCHANGE', err instanceof Error ? err.message : String(err));
    }
  },

  // ── Listings ───────────────────────────────────────────────────────────────

  /**
   * Publishes the product, reusing this row's existing GX listing when it can.
   *
   * Reuse matters because a GX listing is never quantity-updated back to life:
   * after a delist (deactivate → draft) the same listing should be republished
   * with its photos and history, not duplicated. A SOLD listing cannot be
   * reused, so that path creates a new one — which is the relist.
   */
  async publishListing(
    account: MarketplaceAccountRow,
    product: ProductRow,
    request: PublishListingRequest,
  ): Promise<PublishListingResult> {
    log.info({ productId: product.id, sku: product.sku }, 'Publishing listing to Gear Exchange');

    const row = await findListingRow(product.id, account.id);
    const candidateId =
      row?.external_listing_id ??
      (typeof row?.marketplace_metadata?.['gx_listing_id'] === 'string'
        ? (row.marketplace_metadata['gx_listing_id'] as string)
        : null);

    const history = previousIds(row);

    try {
      const existing = candidateId ? await client.getListing(account, candidateId) : null;
      const existingStatus = statusOf(existing);

      // ── Reuse a draft or live listing ────────────────────────────────────
      if (existing && candidateId && existingStatus !== 'sold') {
        const body = await buildBody(account, product, request);
        let result = await client.updateListing(account, candidateId, body);

        if (!isLive(result) && shouldPublishImmediately(account)) {
          result = await client.publishListing(account, candidateId);
        }

        log.info({ gxId: candidateId, status: result.status }, 'Reused existing Gear Exchange listing');

        return publishSuccess(
          candidateId,
          result.price ?? String(body['price']),
          1,
          buildMetadata({ ...result, id: result.id ?? candidateId }, {
            reused_existing: true,
            gx_previous_listing_ids: history,
          }),
        );
      }

      // ── Create a new listing ─────────────────────────────────────────────
      if (existingStatus === 'sold' && candidateId && !history.includes(candidateId)) {
        history.push(candidateId);
      }

      const body = await buildBody(account, product, request, shouldPublishImmediately(account));
      const created = await client.createListing(account, body);
      const createdId = idOf(created);

      if (!createdId) {
        // Same reasoning as Reverb: the create probably succeeded, so this is
        // the moment the operator most needs to be told to go and look.
        log.error({ sku: product.sku, keys: Object.keys(created) }, 'Gear Exchange create returned no id');
        return publishFailure(
          'Gear Exchange accepted the listing but returned no id, so it cannot be tracked. ' +
            'It may still go live — check your Gear Exchange listings before retrying.',
        );
      }

      log.info({ gxId: createdId, sku: product.sku, status: created.status }, 'Created Gear Exchange listing');

      return publishSuccess(
        createdId,
        created.price ?? String(body['price']),
        1,
        buildMetadata(created, {
          gx_previous_listing_ids: history,
          // Created listings start as `draft` while GX imports the photos, then
          // publish themselves. Recorded so the UI can say so instead of
          // implying the listing is visible already.
          images_processing: true,
        }),
      );
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        log.error({ err, sku: product.sku }, 'Gear Exchange rejected the listing');
        return publishFailure(explainError(err));
      }
      throw err;
    }
  },

  async updateListing(
    account: MarketplaceAccountRow,
    product: ProductRow,
    existingListing: MarketplaceListingRow,
    request: PublishListingRequest,
  ): Promise<PublishListingResult> {
    const gxId = externalIdOf(existingListing);

    log.info({ gxId, sku: product.sku }, 'Updating Gear Exchange listing');

    try {
      const current = await client.getListing(account, gxId);

      if (!current) {
        return publishFailure(
          `Gear Exchange listing ${gxId} no longer exists (deleted on Gear Exchange?). ` +
            'Publish again from Gearline to create a new one.',
        );
      }

      /**
       * Sold listings cannot be edited. The unit is gone; if more stock exists,
       * the next unit goes up as a new listing. Reported as success because the
       * row is still correctly ACTIVE for this product — the relist job will
       * replace its external ID.
       */
      if (statusOf(current) === 'sold') {
        if (product.quantity > 0) await enqueueRelist(existingListing, gxId);
        return publishSuccess(gxId, current.price ?? null, 0, buildMetadata(current, {
          gx_previous_listing_ids: previousIds(existingListing),
        }));
      }

      const body = await buildBody(account, product, request);
      const result = await client.updateListing(account, gxId, body);

      return publishSuccess(
        idOf(result) ?? gxId,
        result.price ?? String(body['price']),
        isLive(result) ? 1 : 0,
        buildMetadata({ ...result, id: result.id ?? gxId }, {
          gx_previous_listing_ids: previousIds(existingListing),
        }),
      );
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        log.error({ err, gxId }, 'Gear Exchange rejected the listing update');
        return publishFailure(explainError(err));
      }
      throw err;
    }
  },

  /**
   * Takes the listing off sale by DEACTIVATING it (back to draft), never
   * deleting — a deactivated listing keeps its photos and can be republished.
   *
   * Already gone, already a draft, or already sold all count as done: in each
   * case nothing is for sale, which is the only thing a delist has to ensure.
   */
  async delistListing(account: MarketplaceAccountRow, listing: MarketplaceListingRow): Promise<void> {
    const gxId = externalIdOf(listing);
    const current = await client.getListing(account, gxId);

    if (!current) {
      log.info({ gxId }, 'Gear Exchange listing already gone — nothing to delist');
      return;
    }

    if (!isLive(current)) {
      log.info({ gxId, status: current.status }, 'Gear Exchange listing not live — nothing to delist');
      return;
    }

    await client.deactivateListing(account, gxId);
    log.info({ gxId }, 'Deactivated Gear Exchange listing');
  },

  // ── Inventory ──────────────────────────────────────────────────────────────

  /**
   * GX has no quantity to set. "Syncing inventory" means making the listing's
   * existence match whether there is stock:
   *
   *   live + stock 0   → deactivate
   *   live + stock > 0 → nothing to do (one unit is for sale; that is correct)
   *   sold + stock > 0 → queue a new listing for the next unit
   *   sold + stock 0   → nothing to do
   *   draft            → left alone. A draft the ACTIVE row points at was
   *                      deactivated on Gear Exchange by hand; reviving it is
   *                      not Gearline's call, same as Reverb's adoption rule.
   *
   * quantitySynced reports what GX actually has for sale (0 or 1), so the
   * synced_quantity column tells the truth rather than echoing Shopify.
   */
  async syncInventory(
    account: MarketplaceAccountRow,
    listing: MarketplaceListingRow,
    newQuantity: number,
  ): Promise<InventorySyncResult> {
    const gxId = externalIdOf(listing);

    try {
      const current = await client.getListing(account, gxId);

      if (!current) {
        return inventoryFailure(
          `Gear Exchange listing ${gxId} no longer exists. Publish again from Gearline to relist it.`,
        );
      }

      const status = statusOf(current);

      if (status === 'sold') {
        if (newQuantity > 0) await enqueueRelist(listing, gxId);
        return inventorySuccess(0);
      }

      if (isLive(current)) {
        if (newQuantity <= 0) {
          await client.deactivateListing(account, gxId);
          return inventorySuccess(0);
        }
        return inventorySuccess(1);
      }

      log.info({ gxId, status, newQuantity }, 'Gear Exchange listing is a draft — not reviving it on an inventory sync');
      return inventorySuccess(0);
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) return inventoryFailure(explainError(err));
      throw err;
    }
  },

  // ── Orders ─────────────────────────────────────────────────────────────────

  /**
   * Orders updated since `since`, excluding ones that were sold before it.
   *
   * GX filters on UPDATE time, so an old order that just changed status
   * (delivered, paid out) comes back too. Those are filtered out by soldAt:
   * importing one that predates Gearline's connection would deduct inventory
   * for a sale that happened long ago. Already-imported orders are deduplicated
   * downstream, so the overlap from the timezone pad is harmless.
   */
  async importOrders(account: MarketplaceAccountRow, since: Date | null): Promise<ImportedOrder[]> {
    const sinceDate = since ?? new Date(Date.now() - 86_400_000);
    const windowStart = new Date(sinceDate.getTime() - TIMEZONE_PAD_MS);

    const MAX_PAGES = 100;
    const candidates: GxOrderDto[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await client.getOrders(account, page, gxDateTime(windowStart));
      candidates.push(...batch);
      if (batch.length < client.ORDERS_PER_PAGE) break;
      if (page === MAX_PAGES) log.warn('Gear Exchange order import hit the page cap — results truncated');
    }

    const out: ImportedOrder[] = [];
    let dead = 0;
    let old = 0;

    for (const dto of candidates) {
      if (isDeadOrder(dto)) {
        dead++;
        continue;
      }

      const soldAt = dto.soldAt ? new Date(dto.soldAt).getTime() : Number.NaN;
      // Unparseable dates are kept — failing safe means importing, and the
      // (marketplace, order id) uniqueness stops a double import.
      if (!Number.isNaN(soldAt) && soldAt < windowStart.getTime()) {
        old++;
        continue;
      }

      const mapped = toImportedOrder(dto, await resolveProduct(account, dto));
      if (mapped) out.push(mapped);
    }

    log.info(
      { fetched: candidates.length, ready: out.length, skippedDead: dead, skippedOld: old },
      'Fetched Gear Exchange orders',
    );

    return out;
  },

  async importOrder(account: MarketplaceAccountRow, externalOrderId: string): Promise<ImportedOrder | null> {
    const dto = await client.getOrder(account, externalOrderId);

    if (!dto) {
      log.warn({ externalOrderId }, 'Gear Exchange order not found');
      return null;
    }

    if (isDeadOrder(dto)) {
      log.info({ externalOrderId, status: dto.status }, 'Gear Exchange order is cancelled/refunded — not importing');
      return null;
    }

    return toImportedOrder(dto, await resolveProduct(account, dto));
  },
};
