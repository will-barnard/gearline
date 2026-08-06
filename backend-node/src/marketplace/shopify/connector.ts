import type { MarketplaceAccountRow, MarketplaceListingRow, ProductRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { readCredentials } from '../../security/credential-encryptor.js';
import {
  healthy,
  inventorySuccess,
  publishSuccess,
  unhealthy,
  type ConnectorHealthResult,
  type ImportedOrder,
  type InventorySyncResult,
  type MarketplaceAuthProvider,
  type MarketplaceConnector,
  type PublishListingRequest,
  type PublishListingResult,
} from '../types.js';
import * as client from './client.js';

const log = loggerFor('shopify-connector');

/**
 * Shopify auth provider. Port of ShopifyAuthProvider.
 *
 * Shopify issues PERMANENT access tokens — there is no refresh flow. A token is
 * valid until the merchant uninstalls the app, at which point it is revoked
 * outright and must be re-obtained through a fresh OAuth install.
 *
 * The install/callback flow lives in the OAuth route, not here; this only
 * covers runtime validation.
 */
export const shopifyAuthProvider: MarketplaceAuthProvider = {
  buildAuthorizationUrl(): string {
    throw new Error(
      'Shopify authorization URLs are built by the OAuth route, not this provider',
    );
  },

  exchangeCodeForTokens(): Promise<Record<string, string>> {
    throw new Error('Shopify token exchange is handled by the OAuth route, not this provider');
  },

  async refreshAccessToken(account: MarketplaceAccountRow): Promise<void> {
    // Deliberate no-op. Shopify tokens do not expire.
    log.debug({ accountId: account.id }, 'Shopify tokens do not expire — refresh is a no-op');
  },

  async areCredentialsValid(account: MarketplaceAccountRow): Promise<boolean> {
    // Presence check only — no network call. Genuine revocation detection
    // needs a live request, which checkHealth does on demand.
    const credentials = readCredentials(account.encrypted_credentials);
    const token = credentials['access_token'];
    return typeof token === 'string' && token.trim() !== '';
  },
};

/**
 * Shopify connector. Port of ShopifyConnector.
 *
 * ── Why almost everything is a no-op ─────────────────────────────────────────
 *
 * Shopify is the product SOURCE, not a listing destination. Products flow IN
 * through webhooks; Gearline never creates or manages Shopify listings — the
 * merchant does that in Shopify directly.
 *
 * So this connector exists to make three things safe rather than to do work:
 *
 *   1. The registry never throws for a Shopify account.
 *   2. InventoryConsistencyService can dispatch against Shopify listings
 *      without a runtime crash (it also skips them explicitly, so this is
 *      belt-and-braces).
 *   3. checkHealth can verify the stored token.
 *
 * The no-ops return SUCCESS, not failure. Returning failure would mark listings
 * FAILED and fill the dashboard's failed-listing count with noise for work that
 * was never meant to happen.
 *
 * Real Shopify writes go through order-push.ts (mirroring orders) and the
 * webhook processor (inbound products/inventory/orders).
 */
export const shopifyConnector: MarketplaceConnector = {
  marketplaceType: 'SHOPIFY',

  authProvider: shopifyAuthProvider,

  async checkHealth(account: MarketplaceAccountRow): Promise<ConnectorHealthResult> {
    try {
      // Unlike areCredentialsValid, this makes a real call — a token revoked by
      // an uninstall still LOOKS present in stored credentials.
      const valid = await client.verifyToken(account);
      return valid
        ? healthy('SHOPIFY')
        : unhealthy('SHOPIFY', 'Access token invalid or revoked — reinstall the app');
    } catch (err) {
      return unhealthy('SHOPIFY', err instanceof Error ? err.message : String(err));
    }
  },

  // ── Listings — no-ops ──────────────────────────────────────────────────────

  async publishListing(
    _account: MarketplaceAccountRow,
    product: ProductRow,
    _request: PublishListingRequest,
  ): Promise<PublishListingResult> {
    log.debug({ sku: product.sku }, 'publishListing — no-op (Shopify is the product source)');
    return publishSuccess('', product.price, product.quantity, {});
  },

  async updateListing(
    _account: MarketplaceAccountRow,
    product: ProductRow,
    existingListing: MarketplaceListingRow,
    _request: PublishListingRequest,
  ): Promise<PublishListingResult> {
    log.debug({ sku: product.sku }, 'updateListing — no-op');
    return publishSuccess(
      existingListing.external_listing_id ?? '',
      product.price,
      product.quantity,
      {},
    );
  },

  async delistListing(
    _account: MarketplaceAccountRow,
    listing: MarketplaceListingRow,
  ): Promise<void> {
    log.debug({ listingId: listing.id }, 'delistListing — no-op');
  },

  // ── Inventory — no-op ──────────────────────────────────────────────────────

  /**
   * Shopify inventory is written by order-push.ts when a marketplace order is
   * mirrored, not through this interface. Doing it here as well would
   * double-deduct.
   */
  async syncInventory(
    _account: MarketplaceAccountRow,
    listing: MarketplaceListingRow,
    newQuantity: number,
  ): Promise<InventorySyncResult> {
    log.debug({ listingId: listing.id, newQuantity }, 'syncInventory — no-op');
    return inventorySuccess(newQuantity);
  },

  // ── Orders — no-op ─────────────────────────────────────────────────────────

  /**
   * Shopify orders arrive via the orders/create webhook and are processed
   * synchronously. OrderPollingScheduler excludes Shopify deliberately —
   * polling would duplicate every webhook-delivered order.
   */
  async importOrders(): Promise<ImportedOrder[]> {
    log.debug('importOrders — no-op (Shopify orders arrive via webhook)');
    return [];
  },

  async importOrder(
    _account: MarketplaceAccountRow,
    externalOrderId: string,
  ): Promise<ImportedOrder | null> {
    log.debug({ externalOrderId }, 'importOrder — no-op');
    return null;
  },
};
