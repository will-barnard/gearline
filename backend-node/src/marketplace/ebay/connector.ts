import { db } from '../../db/index.js';
import type { MarketplaceAccountRow, MarketplaceListingRow, ProductRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import {
  healthy,
  inventoryFailure,
  inventorySuccess,
  publishFailure,
  publishSuccess,
  unhealthy,
  PermanentMarketplaceError,
  type ConnectorHealthResult,
  type ImportedOrder,
  type InventorySyncResult,
  type MarketplaceConnector,
  type PublishListingRequest,
  type PublishListingResult,
} from '../types.js';
import { ebayAuthProvider } from './auth-provider.js';
import * as client from './client.js';
import { buildInventoryItemBody, buildOfferBody } from './listing-mapper.js';
import { map as mapOrder } from './order-mapper.js';

const log = loggerFor('ebay-connector');

/**
 * eBay marketplace connector. Port of EbayConnector.
 *
 * ── The three-step publish ───────────────────────────────────────────────────
 *
 *   1. PUT  /inventory_item/{sku}       — idempotent, keyed by OUR sku
 *   2. POST /offer                       — returns an eBay-generated offerId
 *   3. POST /offer/{offerId}/publish     — returns the live listingId
 *
 * The offerId is NOT the listingId, and both matter. The listingId goes in
 * external_listing_id; the offerId is stored in
 * marketplace_metadata["ebay_offer_id"] and is what update and delist need.
 * Losing it means the listing can no longer be managed through the API — hence
 * the sku is stored alongside it, so a lost offer can at least be recreated.
 */

/** Refreshes the token if needed and returns the current account row. */
async function ensureValidToken(account: MarketplaceAccountRow): Promise<MarketplaceAccountRow> {
  if (await ebayAuthProvider.areCredentialsValid(account)) return account;

  log.info({ accountId: account.id }, 'eBay token expired or near-expiry — refreshing');
  await ebayAuthProvider.refreshAccessToken(account);

  // Re-read: refreshAccessToken wrote new credentials, so the caller's copy now
  // holds a stale access token.
  const refreshed = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('id', '=', account.id)
    .executeTakeFirst();

  return refreshed ?? account;
}

function getOfferId(listing: MarketplaceListingRow): string | null {
  const value = listing.marketplace_metadata?.['ebay_offer_id'];
  return value === null || value === undefined ? null : String(value);
}

/**
 * eBay inventory is keyed by SKU, but external_listing_id holds the eBay
 * listingId — a different thing. The sku is written into metadata at publish
 * time precisely so inventory sync can find it later.
 */
function getSku(listing: MarketplaceListingRow): string | null {
  const value = listing.marketplace_metadata?.['sku'];
  return value === null || value === undefined ? null : String(value);
}

/** Creates an offer and extracts its ID, failing loudly if either step is empty. */
async function createOfferOrThrow(
  account: MarketplaceAccountRow,
  sku: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await client.createOffer(account, body);

  if (!response) {
    throw new PermanentMarketplaceError(`createOffer returned an empty response for SKU ${sku}`);
  }

  const offerId = response.offerId;

  if (!offerId || offerId.trim() === '') {
    throw new PermanentMarketplaceError(
      `createOffer returned no offerId for SKU ${sku} — response: ${JSON.stringify(response)}`,
    );
  }

  return offerId;
}

export const ebayConnector: MarketplaceConnector = {
  marketplaceType: 'EBAY',

  authProvider: ebayAuthProvider,

  async checkHealth(account: MarketplaceAccountRow): Promise<ConnectorHealthResult> {
    try {
      // A real call, not just a token-presence check: eBay tokens can be revoked
      // server-side while still looking valid locally.
      const valid = await client.verifyToken(await ensureValidToken(account));
      return valid ? healthy('EBAY') : unhealthy('EBAY', 'Token invalid or expired');
    } catch (err) {
      return unhealthy('EBAY', err instanceof Error ? err.message : String(err));
    }
  },

  // ── Listings ───────────────────────────────────────────────────────────────

  async publishListing(
    account: MarketplaceAccountRow,
    product: ProductRow,
    request: PublishListingRequest,
  ): Promise<PublishListingResult> {
    const current = await ensureValidToken(account);
    const sku = product.sku;

    try {
      // Step 1 — inventory item
      await client.createOrUpdateInventoryItem(current, sku, buildInventoryItemBody(product, request));
      log.info({ sku }, 'eBay inventory item created/updated');

      // Step 2 — offer
      const offerId = await createOfferOrThrow(current, sku, buildOfferBody(sku, product, request));
      log.info({ offerId, sku }, 'eBay offer created');

      // Step 3 — publish
      const publishResponse = await client.publishOffer(current, offerId);
      const listingId = publishResponse?.listingId;

      if (!listingId) {
        /**
         * The offer exists and may even be live, but we have no listingId to
         * store. Reported as a failure so the operator investigates — but the
         * offerId is included in the message, because a silently orphaned offer
         * is very hard to track down afterwards.
         */
        return publishFailure(
          `eBay published offer ${offerId} but returned no listingId. ` +
            'The offer may be live — check Seller Hub before republishing.',
        );
      }

      log.info({ offerId, listingId, sku }, 'eBay offer published');

      return publishSuccess(listingId, request.priceOverride ?? product.price, request.quantity, {
        ebay_offer_id: offerId,
        sku,
      });
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        log.error({ err, sku }, 'eBay rejected the listing');
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
    const current = await ensureValidToken(account);
    const sku = product.sku;

    try {
      // Step 1 — full replace of the inventory item.
      await client.createOrUpdateInventoryItem(current, sku, buildInventoryItemBody(product, request));
      log.info({ sku }, 'eBay inventory item updated');

      // Step 2 — update the offer, or recreate it if the ID was lost.
      const offerBody = buildOfferBody(sku, product, request);
      let offerId = getOfferId(existingListing);

      if (offerId) {
        await client.updateOffer(current, offerId, offerBody);
        log.info({ offerId, sku }, 'eBay offer updated');
      } else {
        // Recovery path: metadata lost the offerId (older listing, or a publish
        // that half-completed). Create a fresh offer rather than failing.
        offerId = await createOfferOrThrow(current, sku, offerBody);
        log.warn({ offerId, sku }, 'eBay offer was missing from metadata — created a new one');
      }

      // Step 3 — republish so the changes go live.
      const publishResponse = await client.publishOffer(current, offerId);
      const listingId = publishResponse?.listingId ?? existingListing.external_listing_id;

      log.info({ offerId, listingId, sku }, 'eBay offer republished');

      return publishSuccess(listingId ?? '', request.priceOverride ?? product.price, request.quantity, {
        ebay_offer_id: offerId,
        sku,
      });
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        log.error({ err, listingId: existingListing.external_listing_id }, 'eBay update failed');
        return publishFailure(err.message);
      }
      throw err;
    }
  },

  async delistListing(
    account: MarketplaceAccountRow,
    listing: MarketplaceListingRow,
  ): Promise<void> {
    const current = await ensureValidToken(account);
    const offerId = getOfferId(listing);

    if (!offerId) {
      /**
       * Nothing to withdraw. Returning rather than throwing is deliberate: the
       * job would otherwise retry five times and dead-letter over a listing
       * that has no eBay offer behind it, which is not a transient condition.
       *
       * Logged at WARN because it can also mean the offerId was lost while the
       * listing IS still live — worth a human look.
       */
      log.warn(
        { listingId: listing.id, externalListingId: listing.external_listing_id },
        'No ebay_offer_id in metadata — cannot withdraw. Check Seller Hub manually.',
      );
      return;
    }

    // withdrawOffer already absorbs 404 as success. Anything else rethrows —
    // a silently failed delist leaves an item for sale with no stock.
    await client.withdrawOffer(current, offerId);
    log.info({ offerId, externalListingId: listing.external_listing_id }, 'eBay offer withdrawn');
  },

  // ── Inventory ──────────────────────────────────────────────────────────────

  /**
   * Syncs quantity via read-modify-write.
   *
   * The Inventory API PUT is a FULL REPLACE. Sending only an availability block
   * would wipe the title, description, images, condition and aspects off a live
   * listing — so the current item is fetched, the quantity merged in, and the
   * complete body sent back.
   */
  async syncInventory(
    account: MarketplaceAccountRow,
    listing: MarketplaceListingRow,
    newQuantity: number,
  ): Promise<InventorySyncResult> {
    const current = await ensureValidToken(account);
    const sku = getSku(listing);

    if (!sku) {
      return inventoryFailure(
        `Cannot sync eBay inventory: no SKU in metadata for listing ${listing.id}. ` +
          'Re-publish the listing to repopulate it.',
      );
    }

    try {
      const existing = await client.getInventoryItem(current, sku);

      if (!existing) {
        // Blindly creating one here would publish a listing with no title or
        // images, so fail and ask for a republish instead.
        log.warn({ sku }, 'eBay inventory item not found — cannot sync quantity');
        return inventoryFailure(
          `eBay inventory item for SKU ${sku} not found; please re-publish the listing`,
        );
      }

      const merged = {
        ...existing,
        availability: { shipToLocationAvailability: { quantity: newQuantity } },
      };

      await client.createOrUpdateInventoryItem(current, sku, merged);
      log.info({ sku, newQuantity }, 'eBay inventory synced');

      return inventorySuccess(newQuantity);
    } catch (err) {
      if (err instanceof PermanentMarketplaceError) {
        return inventoryFailure(err.message);
      }
      throw err;
    }
  },

  // ── Orders ─────────────────────────────────────────────────────────────────

  async importOrders(
    account: MarketplaceAccountRow,
    since: Date | null,
  ): Promise<ImportedOrder[]> {
    const current = await ensureValidToken(account);
    const sinceStr = (since ?? new Date(Date.now() - 86_400_000)).toISOString();

    const results: ImportedOrder[] = [];

    let offset = 0;
    let pages = 0;
    const MAX_PAGES = 100;

    while (pages < MAX_PAGES) {
      let page;

      try {
        page = await client.getOrders(current, sinceStr, offset);
      } catch (err) {
        /**
         * Return what was collected rather than throwing away a partial batch.
         * Orders already mapped are real sales; dropping them because page 4
         * failed would delay every one of them until the next poll.
         */
        log.error({ err, offset }, 'eBay importOrders failed — returning partial results');
        break;
      }

      const orders = page?.orders ?? [];
      if (orders.length === 0) break;

      for (const raw of orders) {
        const mapped = mapOrder(raw);
        if (mapped) results.push(mapped);
      }

      pages++;
      offset += orders.length;

      // eBay signals more pages with a `next` cursor.
      if (!page?.next) break;
    }

    if (pages >= MAX_PAGES) {
      log.warn({ MAX_PAGES }, 'eBay order import hit the page cap — results truncated');
    }

    log.info({ count: results.length, since: sinceStr, accountId: account.id }, 'Imported eBay orders');
    return results;
  },

  async importOrder(
    account: MarketplaceAccountRow,
    externalOrderId: string,
  ): Promise<ImportedOrder | null> {
    const current = await ensureValidToken(account);
    const raw = await client.getOrder(current, externalOrderId);

    if (!raw) {
      log.warn({ externalOrderId }, 'eBay order not found');
      return null;
    }

    const mapped = mapOrder(raw);

    if (!mapped) {
      // Malformed rather than missing — worth surfacing as an error so the
      // dispatcher records it, rather than silently skipping a real sale.
      throw new PermanentMarketplaceError(`Failed to map eBay order ${externalOrderId}`);
    }

    return mapped;
  },
};
