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
import { toImportedOrder } from './order-mapper.js';
import type { ReverbListingDto } from './types.js';

const log = loggerFor('reverb-connector');

const PER_PAGE = 50;

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

    let body: Record<string, unknown>;

    try {
      body = toReverbRequest(product, request, {
        conditionUuid: await conditionUuidFor(current, product, request),
        categoryUuid: await categoryUuidFor(current, product, request),
        publish: shouldPublishImmediately(current),
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
        return publishFailure('Reverb returned a listing with no id');
      }

      log.info({ reverbId: result.id, sku: product.sku }, 'Published Reverb listing');

      return publishSuccess(
        result.id,
        extractPrice(result),
        request.quantity,
        buildMetadata(result),
      );
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        log.error({ err, sku: product.sku }, 'Reverb rejected the listing');
        return publishFailure(explainSkuConflict(err.message, product.sku));
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
      // change listing state.
      body = toReverbRequest(product, request, {
        conditionUuid: await conditionUuidFor(current, product, request),
        categoryUuid: await categoryUuidFor(current, product, request),
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

      return publishSuccess(
        // Reverb may omit the id on an update response; fall back to the one we
        // already hold rather than nulling a valid external ID.
        result.id ?? externalId,
        extractPrice(result),
        request.quantity,
        buildMetadata(result),
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

    try {
      await client.updateInventory(current, externalId, newQuantity);
      return inventorySuccess(newQuantity);
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        return inventoryFailure(err.message);
      }
      throw err;
    }
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

    /** Newer than the watermark? Unparseable dates are kept, to fail safe. */
    const isRecent = (order: ImportedOrder): boolean => {
      if (!order.createdAt) return true;
      const t = new Date(order.createdAt).getTime();
      return Number.isNaN(t) || t >= sinceMs;
    };

    const recent: ImportedOrder[] = [];

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

        if (isRecent(mapped)) {
          pageHadRecent = true;
          recent.push(mapped);
        }
      }

      // Whole page older than the watermark — everything after it is older too.
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

    log.info(
      { scanned: rawCount, recent: recent.length, pages: page, stoppedEarly },
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

    return toImportedOrder(dto);
  },
};
