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
import { toReverbRequest } from './listing-mapper.js';
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
    const body = toReverbRequest(product, request);

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
        return publishFailure(err.message);
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
    const body = toReverbRequest(product, request);

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
   * Imports orders created after `since`, paginating until exhausted.
   *
   * The pagination is load-bearing: an earlier version hardcoded page=1 and
   * silently dropped every order past the first 50. The loop stops when a page
   * comes back short, which is how Reverb signals the last page.
   *
   * A hard page cap guards against a malformed response that always returns a
   * full page — without it this loops forever holding a job slot.
   */
  async importOrders(
    account: MarketplaceAccountRow,
    since: Date | null,
  ): Promise<ImportedOrder[]> {
    // Default to the last 24 hours, matching the Java fallback.
    const sinceStr = (since ?? new Date(Date.now() - 86_400_000)).toISOString();

    log.info({ since: sinceStr }, 'Importing Reverb orders');

    const current = await ensureValidToken(account);
    const collected: ReturnType<typeof toImportedOrder>[] = [];

    const MAX_PAGES = 100;
    let page = 1;
    let rawCount = 0;

    while (page <= MAX_PAGES) {
      const batch = await client.getOrders(current, sinceStr, page);
      if (batch.length === 0) break;

      rawCount += batch.length;
      for (const dto of batch) collected.push(toImportedOrder(dto));

      if (batch.length < PER_PAGE) break;
      page++;
    }

    if (page > MAX_PAGES) {
      log.warn({ maxPages: MAX_PAGES }, 'Reverb order import hit the page cap — results truncated');
    }

    // toImportedOrder returns null for orders with no identifiable ID. Filter
    // them here so they never reach OrderImportService.
    const mapped = collected.filter((o): o is ImportedOrder => o !== null);
    const skipped = rawCount - mapped.length;

    if (skipped > 0) {
      log.warn({ skipped }, 'Skipped Reverb order(s) with no identifiable ID');
    }

    log.info({ count: mapped.length, pages: page }, 'Fetched Reverb orders');
    return mapped;
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
