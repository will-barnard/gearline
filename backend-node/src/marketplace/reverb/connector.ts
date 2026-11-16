import { config } from '../../config.js';
import { db } from '../../db/index.js';
import type { MarketplaceAccountRow, MarketplaceListingRow, ProductRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import {
  inventoryFailure,
  inventorySuccess,
  publishFailure,
  publishSuccess,
  unhealthy,
  healthy,
  PermanentMarketplaceError,
  type ConnectorHealthResult,
  type ImportedOrder,
  type InventorySyncResult,
  type MarketplaceConnector,
  type PublishListingRequest,
  type PublishListingResult,
} from '../types.js';
import { reverbAuthProvider } from './auth-provider.js';
import * as client from './client.js';
import { configuredCategoryFor, resolveCategoryUuid } from './categories.js';
import { resolveConditionUuid } from './conditions.js';
import { mapCondition, toReverbRequest } from './listing-mapper.js';
import {
  PREVIOUS_IDS_KEY,
  RELIST_SKU_KEY,
  allListingIds,
  needsRelist,
  previousListingIds,
  relistSku,
} from './relist.js';
import { toImportedOrder } from './order-mapper.js';
import { enqueue } from '../../queue/sync-job-producer.js';
import { PHOTO_SOURCES_KEY, reverbPhotos, syncListingPhotos } from './photo-sync.js';
import {
  isBehindWatermark,
  isImportCandidate,
  isInRescanWindow,
  rescanWindowStartMs,
} from './order-window.js';
import type { ReverbListingDto } from './types.js';

const log = loggerFor('reverb-connector');

const PER_PAGE = 50;

/** Which of these Reverb order IDs are already in the orders table? */
async function knownReverbOrderIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .selectFrom('orders')
    .select('external_order_id')
    .where('marketplace_type', '=', 'REVERB')
    .where('external_order_id', 'in', ids)
    .execute();
  return new Set(rows.map((r) => r.external_order_id));
}

/**
 * Reverb marketplace connector. Port of ReverbConnector.
 *
 * ── Error contract ───────────────────────────────────────────────────────────
 *
 * publish/update/syncInventory catch PERMANENT errors and return a failure
 * result, so the dispatcher records the message on the listing and the operator
 * sees it in the UI. RETRYABLE errors (429, 5xx, network) are allowed to
 * propagate so the consumer's retry ladder handles them.
 *
 * delist is the exception: it rethrows everything. A delist that quietly
 * "succeeds" while the listing is still live on Reverb is far worse than a
 * failed job, because the item stays for sale with no stock behind it. The
 * only tolerated failure is a 404, which client.endListing already absorbs.
 */

/**
 * Refreshes the token if needed and returns the current account row.
 *
 * Returning the refreshed row matters: refreshAccessToken writes new
 * credentials to the database, so the caller's copy is stale immediately
 * afterwards and would send the OLD access token.
 */
async function ensureValidToken(account: MarketplaceAccountRow): Promise<MarketplaceAccountRow> {
  if (await reverbAuthProvider.areCredentialsValid(account)) return account;

  log.info({ accountId: account.id }, 'Reverb token expired — refreshing');
  await reverbAuthProvider.refreshAccessToken(account);

  const refreshed = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('id', '=', account.id)
    .executeTakeFirst();

  return refreshed ?? account;
}

function extractPrice(dto: ReverbListingDto): string {
  const amount = dto.price?.amount;

  if (amount && /^-?\d+(\.\d+)?$/.test(amount)) return amount;

  if (amount) log.warn({ amount }, 'Could not parse Reverb listing price');
  return '0';
}

function buildMetadata(dto: ReverbListingDto): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    reverb_id: dto.id ?? null,
    slug: dto.slug ?? null,
  };

  if (dto._links?.web?.href) metadata['listing_url'] = dto._links.web.href;
  if (dto._links?.manage_url?.href) metadata['manage_url'] = dto._links.manage_url.href;

  return metadata;
}

/**
 * Resolves the condition UUID for a publish, honouring a per-listing
 * `condition_mapping` override before the product's own condition.
 *
 * The override is a slug or display name ("b-stock", "Non Functioning"), not a
 * UUID — operators set it from the Reverb vocabulary, not from internal IDs.
 */
async function conditionUuidFor(
  account: MarketplaceAccountRow,
  product: ProductRow,
  request: PublishListingRequest,
): Promise<string> {
  const slug = request.conditionMapping ?? mapCondition(product.condition);
  return resolveConditionUuid(account, slug);
}

/**
 * Resolves the Reverb category UUID for a publish.
 *
 * Fails permanently when nothing is configured. The alternative — publishing
 * without a category — produces a listing that is silently stuck as a draft,
 * which is exactly the failure mode this whole path exists to avoid.
 */
async function categoryUuidFor(
  account: MarketplaceAccountRow,
  product: ProductRow,
  request: PublishListingRequest,
): Promise<string> {
  const configured = configuredCategoryFor(account, product, request.categoryId);

  if (!configured) {
    throw new PermanentMarketplaceError(
      `No Reverb category configured for product type "${product.category ?? '(none)'}". ` +
        'Reverb will not publish a listing without one. Add an entry to ' +
        'reverb_category_map in the Reverb account settings (e.g. ' +
        '{"Cables": "Parts & Accessories / Cables"}), set reverb_default_category, ' +
        "or set category_id on this listing's overrides.",
    );
  }

  return resolveCategoryUuid(account, configured);
}

/**
 * Adds the missing half of Reverb's SKU-collision message.
 *
 * "SKU already exists in your shop" is accurate but hides the usual cause: a
 * DRAFT from an earlier failed publish. Drafts are invisible in the storefront
 * yet still hold their SKU, so the operator sees no listing anywhere and no
 * amount of retrying will ever succeed. Naming the cause turns a dead end into
 * a two-minute fix.
 */
function explainSkuConflict(message: string, sku: string): string {
  if (!/sku already exists/i.test(message)) return message;

  return (
    `${message} — a listing on Reverb already uses SKU "${sku}". This is often a ` +
    'draft left by an earlier failed publish: drafts do not appear in your ' +
    'storefront but still hold their SKU. Check Selling → Listings → Drafts on ' +
    'Reverb and delete or publish it, then retry.'
  );
}

/**
 * Whether a newly created listing should go live immediately.
 *
 * Defaults to TRUE. A Reverb create always produces a draft, and a draft is
 * invisible in the storefront while still consuming its SKU — so the default
 * has to match what "publish to Reverb" plainly means, or every listing needs a
 * second manual step on Reverb.
 *
 * Sellers who want to review on Reverb before going live can set
 * `reverb_publish_immediately: false` in the account's sync_settings; listings
 * then stay as drafts.
 */
function shouldPublishImmediately(account: MarketplaceAccountRow): boolean {
  const setting = account.sync_settings?.['reverb_publish_immediately'];
  return setting !== false && setting !== 'false';
}

function requireExternalId(listing: MarketplaceListingRow): string {
  if (!listing.external_listing_id) {
    throw new PermanentMarketplaceError(
      `Reverb listing ${listing.id} has no external_listing_id — it was never published`,
    );
  }
  return listing.external_listing_id;
}

/**
 * Recovers from a SKU collision by taking ownership of the listing Reverb
 * already has.
 *
 * Returns null when this was not a SKU collision, when no listing with an
 * EXACT SKU match can be found, or when the lookup itself fails — in every
 * one of those cases the caller falls back to reporting the original error,
 * because a wrong adoption is worse than a failed publish: it would point
 * gearline at someone else's listing and then overwrite it.
 *
 * On success the listing is updated with this product's data and returned as
 * a normal publish result, so the external ID is recorded and every later
 * update, delist and inventory sync works against it.
 */
async function adoptExistingListing(
  account: MarketplaceAccountRow,
  product: ProductRow,
  request: PublishListingRequest,
  cause: PermanentMarketplaceError,
  /** The SKU the failed create carried — a relist's `-R1` SKU, not the product's own. */
  sku: string = product.sku,
): Promise<PublishListingResult | null> {
  if (!/sku already exists/i.test(cause.message)) return null;

  let existing;

  try {
    existing = await client.findListingBySku(account, sku);
  } catch (lookupErr) {
    log.warn(
      { err: lookupErr, sku },
      'SKU collision, but the Reverb lookup failed — reporting the original error',
    );
    return null;
  }

  if (!existing?.id) {
    log.warn(
      { sku },
      'Reverb reported a SKU collision but no listing with that exact SKU came back',
    );
    return null;
  }

  log.info(
    { sku, reverbId: existing.id, state: existing.state },
    'Adopting the existing Reverb listing that already holds this SKU',
  );

  let result;

  try {
    result = await client.updateListing(
      account,
      existing.id,
      toReverbRequest(product, request, {
        conditionUuid: await conditionUuidFor(account, product, request),
        categoryUuid: await categoryUuidFor(account, product, request),
        // No publish on an adoption. If the operator had deliberately ended
        // or drafted this listing, silently reviving it is not our call.
        // No photos either: the listing already has its own, and Reverb adds
        // to them rather than replacing.
        includePhotos: false,
        sku,
      }),
    );
  } catch (updateErr) {
    if (updateErr instanceof PermanentMarketplaceError) {
      log.error({ err: updateErr, reverbId: existing.id }, 'Adopted listing but could not update it');

      /**
       * The listing is already LIVE on Reverb and matched by exact SKU, so the
       * failed update only means its fields were not refreshed. Reporting that
       * as a failed publish leaves a live listing with no ID in gearline: a sale
       * elsewhere could never end it, so it would sell with no stock behind it.
       * Track it, and keep the reason in metadata and the logs.
       *
       * Only for a live listing. A draft or ended one is not selling anything, so
       * the failure stays a failure and nothing is marked ACTIVE that is not.
       */
      if (client.listingStateSlug(existing) === 'live') {
        log.warn(
          { reverbId: existing.id, sku },
          'Adopting live Reverb listing despite failed update',
        );
        const metadata = buildMetadata(existing);
        metadata['adopted_existing'] = true;
        metadata['adopt_update_error'] = updateErr.message.slice(0, 500);
        // Quantity is null: the update that would have synced it did not apply.
        return publishSuccess(String(existing.id), extractPrice(existing), null, metadata);
      }

      return publishFailure(
        `Adopted the existing Reverb listing ${existing.id}, but updating it failed: ${updateErr.message}`,
      );
    }
    throw updateErr;
  }

  const metadata = buildMetadata(result);
  metadata['adopted_existing'] = true;

  return publishSuccess(
    String(result.id ?? existing.id),
    extractPrice(result),
    request.quantity,
    metadata,
  );
}

/** The row this product's Reverb listing lives on, if it has one yet. */
async function listingRowFor(
  account: MarketplaceAccountRow,
  product: ProductRow,
): Promise<MarketplaceListingRow | undefined> {
  return db
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', product.id)
    .where('marketplace_account_id', '=', account.id)
    .executeTakeFirst();
}

/**
 * Queues the publish of the NEXT unit after a used-condition listing sold.
 *
 * The dispatcher runs it as an ordinary LISTING_PUBLISH for this row;
 * publishListing below notices the row's current Reverb listing is locked and
 * creates the replacement. Idempotent per sold listing: the order import and
 * every retry of the inventory sync can all notice the same sale, and only one
 * new listing may come of it.
 */
async function enqueueRelist(listing: MarketplaceListingRow, soldReverbId: string): Promise<void> {
  await enqueue({
    jobType: 'LISTING_PUBLISH',
    marketplaceType: 'REVERB',
    marketplaceAccountId: listing.marketplace_account_id,
    productId: listing.product_id,
    listingId: listing.id,
    payload: { reason: 'reverb_relist_after_sale', soldListingId: soldReverbId },
    idempotencyKey: `reverb-relist-${listing.id}-${soldReverbId}`,
  });

  log.info(
    { listingId: listing.id, soldReverbId },
    'Reverb listing is locked after its sale and more units are for sale — queued a new listing for the next unit',
  );
}

function stateAndCondition(dto: ReverbListingDto | null): { state: string | null; conditionSlug: string | null } {
  return {
    state: dto ? client.listingStateSlug(dto) : null,
    conditionSlug: dto?.condition?.slug?.toLowerCase() ?? null,
  };
}

/**
 * Re-points line items on a Reverb order at the Gearline product they sold,
 * by Reverb LISTING ID.
 *
 * A relisted unit carries a suffixed SKU (relist.ts), so the SKU on its order
 * is not a product SKU and inventory deduction, restocking and the Shopify
 * mirror order would all miss it. The listing id is stable: it is either the
 * row's current id or one it has retired. When a row is found the line item
 * gets the product's own id and SKU; when none is, the item is left exactly as
 * Reverb sent it, so nothing changes for listings made any other way.
 */
async function attachGearlineProducts(
  account: MarketplaceAccountRow,
  lineItems: ImportedOrder['lineItems'],
): Promise<ImportedOrder['lineItems']> {
  const ids = lineItems.map((li) => li.externalListingId).filter((id): id is string => !!id);
  if (ids.length === 0) return lineItems;

  const rows = await db
    .selectFrom('marketplace_listings')
    .select(['product_id', 'external_listing_id', 'marketplace_metadata'])
    .where('marketplace_account_id', '=', account.id)
    .where('marketplace_type', '=', 'REVERB')
    .execute();

  const out: ImportedOrder['lineItems'] = [];

  for (const li of lineItems) {
    const row = li.externalListingId
      ? rows.find((r) => allListingIds(r).includes(li.externalListingId as string))
      : undefined;

    if (!row) {
      out.push(li);
      continue;
    }

    const product = await db
      .selectFrom('products')
      .select(['id', 'sku'])
      .where('id', '=', row.product_id)
      .executeTakeFirst();

    out.push(product ? { ...li, productId: product.id, sku: product.sku } : li);
  }

  return out;
}

export const reverbConnector: MarketplaceConnector = {
  marketplaceType: 'REVERB',

  authProvider: reverbAuthProvider,

  // ── Health ─────────────────────────────────────────────────────────────────

  async checkHealth(account: MarketplaceAccountRow): Promise<ConnectorHealthResult> {
    try {
      const valid = await client.verifyToken(account);
      return valid ? healthy('REVERB') : unhealthy('REVERB', 'Token validation failed');
    } catch (err) {
      return unhealthy('REVERB', err instanceof Error ? err.message : String(err));
    }
  },

  // ── Listings ───────────────────────────────────────────────────────────────

  async publishListing(
    account: MarketplaceAccountRow,
    product: ProductRow,
    request: PublishListingRequest,
  ): Promise<PublishListingResult> {
    log.info({ productId: product.id, sku: product.sku }, 'Publishing listing to Reverb');

    const current = await ensureValidToken(account);

    /**
     * ── Relist after a sale ────────────────────────────────────────────────
     *
     * If this product's row already points at a Reverb listing that sold and is
     * locked (a used-condition listing after its first sale — see relist.ts),
     * the next unit is a NEW listing under a suffixed SKU, and the sold id is
     * remembered. Anything else — no row, no id, a live or draft listing — is
     * the ordinary publish it always was.
     */
    const row = await listingRowFor(current, product);
    const history = previousListingIds(row);
    let relisting = false;

    if (row?.external_listing_id) {
      const dto = await client.getListing(current, row.external_listing_id);
      if (needsRelist(stateAndCondition(dto), request.quantity)) {
        relisting = true;
        history.unshift(row.external_listing_id);
        log.info(
          { sku: product.sku, soldReverbId: row.external_listing_id, generation: history.length },
          'Previous Reverb listing sold and is locked — creating a new one for the next unit',
        );
      }
    }

    const sku = relisting ? relistSku(product.sku, history) : product.sku;

    let body: Record<string, unknown>;

    try {
      body = toReverbRequest(product, request, {
        conditionUuid: await conditionUuidFor(current, product, request),
        categoryUuid: await categoryUuidFor(current, product, request),
        publish: shouldPublishImmediately(current),
        sku,
      });
    } catch (err) {
      // An unresolvable condition or category is permanent — retrying cannot
      // invent one.
      if (err instanceof PermanentMarketplaceError) {
        log.error({ err, sku: product.sku }, 'Could not build the Reverb listing');
        return publishFailure(err.message);
      }
      throw err;
    }

    try {
      const result = await client.createListing(current, body);

      if (!result.id) {
        /**
         * Reverb accepted the create but the id is not where it was expected.
         * This is NOT a timing effect — the create is synchronous — so it means
         * the response shape moved. Naming the keys that DID come back is the
         * difference between a two-minute fix and another round of guessing.
         *
         * The listing itself is probably live, so this is also the moment the
         * operator most needs to know something is wrong.
         */
        log.error(
          { sku: product.sku, responseKeys: Object.keys(result) },
          'Reverb create returned no listing id',
        );

        return publishFailure(
          'Reverb accepted the listing but returned no id, so it cannot be tracked. ' +
            `The response contained: ${Object.keys(result).join(', ') || '(nothing)'}. ` +
            'The listing may still be live on Reverb — check your Reverb listings before retrying.',
        );
      }

      log.info({ reverbId: result.id, sku: product.sku }, 'Published Reverb listing');

      return publishSuccess(
        String(result.id),
        extractPrice(result),
        request.quantity,
        {
          ...buildMetadata(result),
          // What was sent, so a later photo change knows these are ours to
          // replace (photo-sync.ts).
          [PHOTO_SOURCES_KEY]: reverbPhotos(request.imageUrls),
          // The dispatcher replaces the row's metadata wholesale, so the history
          // of retired listings has to travel with this result or it is lost.
          ...(history.length > 0 ? { [PREVIOUS_IDS_KEY]: history } : {}),
          ...(relisting ? { [RELIST_SKU_KEY]: sku } : {}),
        },
      );
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        /**
         * A SKU collision means Reverb already holds a listing for this
         * product — a draft from an earlier failure, a double-clicked publish,
         * or one created by hand. Recording a plain failure here is the worst
         * outcome available: the listing is real, possibly LIVE, and gearline
         * would hold no ID for it, so it could never be updated, delisted, or
         * inventory-synced. It would sell with no stock behind it.
         *
         * So adopt it instead.
         */
        const adopted = await adoptExistingListing(current, product, request, err, sku);
        if (adopted) {
          // An adopted relist still retires the sold listing it replaces.
          if (history.length > 0) adopted.rawMetadata[PREVIOUS_IDS_KEY] = history;
          if (relisting) adopted.rawMetadata[RELIST_SKU_KEY] = sku;
          return adopted;
        }

        log.error({ err, sku }, 'Reverb rejected the listing');
        return publishFailure(explainSkuConflict(err.message, sku));
      }
      throw err; // retryable — let the consumer's ladder handle it
    }
  },

  async updateListing(
    account: MarketplaceAccountRow,
    product: ProductRow,
    existingListing: MarketplaceListingRow,
    request: PublishListingRequest,
  ): Promise<PublishListingResult> {
    const externalId = requireExternalId(existingListing);

    log.info({ externalId, sku: product.sku }, 'Updating Reverb listing');

    const current = await ensureValidToken(account);

    let body: Record<string, unknown>;

    try {
      // No `publish` on update — see ReverbRequestOptions. An update must not
      // change listing state. No `photos` either: Reverb appends them — photo
      // changes go through syncListingPhotos below.
      body = toReverbRequest(product, request, {
        conditionUuid: await conditionUuidFor(current, product, request),
        categoryUuid: await categoryUuidFor(current, product, request),
        includePhotos: false,
      });
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        log.error({ err, externalId }, 'Could not build the Reverb listing');
        return publishFailure(err.message);
      }
      throw err;
    }

    try {
      const result = await client.updateListing(current, externalId, body);

      // Photos are never in the update body (Reverb appends them); a photo
      // change is applied as its own replace step.
      const photoMetadata = await syncListingPhotos(current, externalId, existingListing, request);

      return publishSuccess(
        // Reverb may omit the id on an update response; fall back to the one we
        // already hold rather than nulling a valid external ID.
        String(result.id ?? externalId),
        extractPrice(result),
        request.quantity,
        { ...buildMetadata(result), ...photoMetadata },
      );
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        log.error({ err, externalId }, 'Reverb rejected the listing update');
        return publishFailure(err.message);
      }
      throw err;
    }
  },

  async delistListing(
    account: MarketplaceAccountRow,
    listing: MarketplaceListingRow,
  ): Promise<void> {
    const externalId = requireExternalId(listing);

    log.info({ externalId }, 'Delisting Reverb listing');

    const current = await ensureValidToken(account);

    // Everything rethrows. See the error contract note above — a silently
    // failed delist leaves a live listing with no stock behind it.
    await client.endListing(current, externalId);

    log.info({ externalId }, 'Delisted Reverb listing');
  },

  // ── Inventory ──────────────────────────────────────────────────────────────

  async syncInventory(
    account: MarketplaceAccountRow,
    listing: MarketplaceListingRow,
    newQuantity: number,
  ): Promise<InventorySyncResult> {
    const externalId = requireExternalId(listing);

    log.info({ externalId, newQuantity }, 'Syncing Reverb inventory');

    const current = await ensureValidToken(account);

    /**
     * ── A sold used-condition listing cannot be restocked ──────────────────
     *
     * After a sale Gearline tops the listing back up. For a used condition
     * Reverb has locked the listing in "Ordered", so that either errors or
     * quietly changes nothing. If more units ARE for sale, the next one goes up
     * as a new listing (publishListing); synced_quantity reports 0 meanwhile
     * because nothing is for sale on the locked one.
     */
    let readBack: ReverbListingDto | null;

    try {
      readBack = await client.updateInventory(current, externalId, newQuantity);
    } catch (err) {
      if (!(err instanceof PermanentMarketplaceError)) throw err;

      const dto = await client.getListing(current, externalId).catch(() => null);

      if (needsRelist(stateAndCondition(dto), newQuantity)) {
        await enqueueRelist(listing, externalId);
        return inventorySuccess(0);
      }

      return inventoryFailure(err.message);
    }

    if (needsRelist(stateAndCondition(readBack), newQuantity)) {
      await enqueueRelist(listing, externalId);
      return inventorySuccess(0);
    }

    return inventorySuccess(newQuantity);
  },

  // ── Orders ─────────────────────────────────────────────────────────────────

  /**
   * Imports orders created after `since`.
   *
   * ── Reverb ignores created_after ────────────────────────────────────────────
   *
   * Observed in production: passing `created_after` still returns the COMPLETE
   * order history. A poll with a 7-minute window came back with 321 orders
   * across 7 pages, the oldest several years old. Every cycle. Deduplication
   * caught them all, so no bad data — but it burned 7 API calls and ~26 seconds
   * per poll, and would eventually trip Reverb's rate limits.
   *
   * Rather than guess at the correct parameter name or date format, this filters
   * CLIENT-SIDE. That is correct whether or not Reverb ever honours the filter.
   *
   * Two mechanisms:
   *
   *   1. Stop paginating once an entire page is older than `since`. Reverb
   *      returns newest-first, so everything beyond that point is older still.
   *      Checking a whole page rather than a single order keeps this safe if
   *      the ordering is ever less strict than it appears.
   *
   *   2. Filter the mapped results by createdAt as a backstop, in case ordering
   *      assumptions do not hold.
   *
   * ── Orders paid after they were created ────────────────────────────────────
   *
   * `created_at` is when Reverb created the order, not when it was paid. An
   * accepted offer can sit unpaid for a day, so by the time it is paid it is
   * older than the watermark and a pure `createdAt >= since` filter loses it
   * for good. So the scan window is the LONGER of the watermark and
   * reverbRescanDays, and any order in it that is not already imported is a
   * candidate. Behind the watermark only paid-type statuses qualify (see
   * order-window.ts). The same rescan also retries an order whose detail
   * fetch failed, rather than relying on the watermark being held back.
   *
   * ── Line items ─────────────────────────────────────────────────────────────
   *
   * The list endpoint does NOT include the nested `listing` object — only the
   * single-order GET does. An order mapped from the list therefore has no SKU,
   * which means NO INVENTORY DEDUCTION when it is imported.
   *
   * So each order that survives the date filter is re-fetched individually to
   * get its line items. That is normally 0–2 calls per poll, versus the 321
   * orders the list returns.
   */
  async importOrders(
    account: MarketplaceAccountRow,
    since: Date | null,
  ): Promise<ImportedOrder[]> {
    // Default to the last 24 hours, matching the Java fallback.
    const sinceDate = since ?? new Date(Date.now() - 86_400_000);
    const sinceStr = sinceDate.toISOString();
    const sinceMs = sinceDate.getTime();

    log.info({ since: sinceStr }, 'Importing Reverb orders');

    const current = await ensureValidToken(account);

    const windowStart = rescanWindowStartMs(sinceMs, Date.now(), config.orderPolling.reverbRescanDays);
    const candidates: ImportedOrder[] = [];

    const MAX_PAGES = 100;
    let page = 1;
    let rawCount = 0;
    let unidentified = 0;
    let stoppedEarly = false;

    while (page <= MAX_PAGES) {
      const batch = await client.getOrders(current, sinceStr, page);
      if (batch.length === 0) break;

      rawCount += batch.length;

      let pageHadRecent = false;

      for (const dto of batch) {
        const mapped = toImportedOrder(dto);

        // toImportedOrder returns null when there is no identifiable ID.
        if (!mapped) {
          unidentified++;
          continue;
        }

        if (isInRescanWindow(mapped, windowStart)) pageHadRecent = true;
        if (isImportCandidate(mapped, sinceMs, windowStart)) candidates.push(mapped);
      }

      // Whole page older than the scan window — everything after it is older too.
      if (!pageHadRecent) {
        stoppedEarly = true;
        break;
      }

      if (batch.length < PER_PAGE) break;
      page++;
    }

    if (page > MAX_PAGES) {
      log.warn({ maxPages: MAX_PAGES }, 'Reverb order import hit the page cap — results truncated');
    }

    if (unidentified > 0) {
      log.warn({ skipped: unidentified }, 'Skipped Reverb order(s) with no identifiable ID');
    }

    // Only orders we have not already imported cost a detail fetch.
    const known = await knownReverbOrderIds(candidates.map((o) => o.externalOrderId));
    const recent = candidates.filter((o) => !known.has(o.externalOrderId));

    for (const o of recent) {
      if (isBehindWatermark(o, sinceMs)) {
        log.warn(
          { externalOrderId: o.externalOrderId, createdAt: o.createdAt, status: o.marketplaceStatus },
          'Reverb order is older than the watermark but not imported (paid after creation, or missed) — importing',
        );
      }
    }

    log.info(
      {
        scanned: rawCount,
        candidates: candidates.length,
        recent: recent.length,
        pages: page,
        stoppedEarly,
      },
      'Fetched Reverb orders',
    );

    if (recent.length === 0) return [];

    /**
     * Re-fetch each recent order individually for its line items.
     *
     * A failure here drops that order from the batch rather than importing it
     * without line items — an order with no SKU imports silently and never
     * deducts inventory, which is worse than retrying next cycle. The polling
     * scheduler does not advance lastSyncAt on failure, so it will be retried.
     */
    const detailed: ImportedOrder[] = [];

    for (const summary of recent) {
      try {
        const full = await this.importOrder(current, summary.externalOrderId);

        if (full && full.lineItems.length > 0) {
          detailed.push(full);
        } else if (full) {
          log.warn(
            { externalOrderId: summary.externalOrderId },
            'Reverb order detail still has no line items — skipping so inventory is not silently missed',
          );
        }
      } catch (err) {
        log.error(
          { err, externalOrderId: summary.externalOrderId },
          'Failed to fetch Reverb order detail — will retry next poll',
        );
      }
    }

    log.info({ count: detailed.length }, 'Reverb orders ready for import');
    return detailed;
  },

  async importOrder(
    account: MarketplaceAccountRow,
    externalOrderId: string,
  ): Promise<ImportedOrder | null> {
    const current = await ensureValidToken(account);
    const dto = await client.getOrder(current, externalOrderId);

    if (!dto) {
      log.warn({ externalOrderId }, 'Reverb getOrder returned null — order not found');
      return null;
    }

    const mapped = toImportedOrder(dto);

    if (mapped && mapped.lineItems.length === 0) {
      // Field NAMES only (no values) — enough to see where the item data lives.
      log.warn(
        { externalOrderId, fields: Object.keys(dto), listingFields: Object.keys(dto.listing ?? {}) },
        'Reverb order detail carries no recognisable item data — logging its field names',
      );
    }

    // Match by listing id so a relisted unit's suffixed SKU still finds its product.
    if (mapped) mapped.lineItems = await attachGearlineProducts(current, mapped.lineItems);

    return mapped;
  },
};
