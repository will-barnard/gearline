/**
 * Marketplace connector contracts.
 *
 * Port of the com.gearline.marketplace.common.connector interfaces. In Java
 * these were four separate interfaces composed into MarketplaceConnector;
 * expressed here as one interface with grouped methods, because TypeScript
 * structural typing gives no benefit from splitting them and one file is easier
 * to keep in sync across three implementations.
 *
 * The contract each connector must honour:
 *
 *   - publishListing / updateListing return a result object; they do NOT throw
 *     for marketplace-level rejections (bad category, missing policy). Those are
 *     `{ success: false, errorMessage }` so the dispatcher can record the error
 *     on the listing. Throw only for genuinely retryable failures — network,
 *     5xx, rate limit — because throwing is what triggers the retry ladder.
 *
 *   - delistListing must be idempotent and must NOT throw when the listing is
 *     already gone on the external system. A delist that fails permanently
 *     leaves an item for sale that Gearline thinks is dead.
 *
 *   - syncInventory must be idempotent — the same quantity sent twice is normal
 *     and must not error.
 */

import type {
  MarketplaceAccountRow,
  MarketplaceListingRow,
  MarketplaceType,
  OrderLineItemJson,
  ProductRow,
  BuyerInfoJson,
  ShippingAddressJson,
} from '../db/types.js';
import type { ShippingDetails } from '../services/shipping-calculator.js';

// ── Normalised request/result DTOs ───────────────────────────────────────────

/**
 * Built exclusively by ListingAttributeResolver. Connector mappers read from
 * this and translate to marketplace-specific field names.
 *
 * All money is a decimal STRING, never a number — see util/decimal.ts.
 */
export interface PublishListingRequest {
  /** Falls back to product title when null. */
  titleOverride: string | null;
  /** Falls back to product description when null. */
  descriptionOverride: string | null;
  /** Falls back to product price when null. Decimal string. */
  priceOverride: string | null;
  quantity: number;
  imageUrls: string[];
  categoryId: string | null;
  conditionMapping: string | null;
  shippingDetails: ShippingDetails | null;
  /**
   * Marketplace-specific keys with no typed field above — reverb_model,
   * ebay_item_specifics, ebay_fulfillment_policy_id, and so on. Passed through
   * untouched so the resolver does not need to know each marketplace's schema.
   */
  extraParams: Record<string, unknown>;
}

export interface PublishListingResult {
  success: boolean;
  externalListingId: string | null;
  /** Decimal string actually published, for the synced_price column. */
  publishedPrice: string | null;
  publishedQuantity: number | null;
  errorMessage: string | null;
  /** Opaque marketplace response data stored on the listing for audit. */
  rawMetadata: Record<string, unknown>;
}

export interface InventorySyncResult {
  success: boolean;
  quantitySynced: number;
  errorMessage: string | null;
}

export interface ImportedOrder {
  externalOrderId: string;
  marketplaceOrderUrl: string | null;
  lineItems: OrderLineItemJson[];
  subtotal: string | null;
  shippingTotal: string | null;
  taxTotal: string | null;
  totalAmount: string | null;
  currency: string | null;
  buyerInfo: BuyerInfoJson | null;
  shippingAddress: ShippingAddressJson | null;
  createdAt: string | null;
}

export interface ConnectorHealthResult {
  healthy: boolean;
  message: string;
  marketplaceType: MarketplaceType;
}

// ── Result constructors ──────────────────────────────────────────────────────

export const publishSuccess = (
  externalListingId: string,
  publishedPrice: string | null,
  publishedQuantity: number | null,
  rawMetadata: Record<string, unknown> = {},
): PublishListingResult => ({
  success: true,
  externalListingId,
  publishedPrice,
  publishedQuantity,
  errorMessage: null,
  rawMetadata,
});

export const publishFailure = (errorMessage: string): PublishListingResult => ({
  success: false,
  externalListingId: null,
  publishedPrice: null,
  publishedQuantity: null,
  errorMessage,
  rawMetadata: {},
});

export const inventorySuccess = (quantitySynced: number): InventorySyncResult => ({
  success: true,
  quantitySynced,
  errorMessage: null,
});

export const inventoryFailure = (errorMessage: string): InventorySyncResult => ({
  success: false,
  quantitySynced: 0,
  errorMessage,
});

export const healthy = (marketplaceType: MarketplaceType): ConnectorHealthResult => ({
  healthy: true,
  message: 'OK',
  marketplaceType,
});

export const unhealthy = (
  marketplaceType: MarketplaceType,
  message: string,
): ConnectorHealthResult => ({ healthy: false, message, marketplaceType });

// ── Auth provider ────────────────────────────────────────────────────────────

export interface MarketplaceAuthProvider {
  buildAuthorizationUrl(state: string, redirectUri: string): string;

  exchangeCodeForTokens(code: string, redirectUri: string): Promise<Record<string, string>>;

  /**
   * Refreshes the access token and PERSISTS the updated credentials.
   *
   * Note this writes to marketplace_accounts. The Java version had a subtle
   * consequence worth remembering: refreshing mid-poll bumps the row's version
   * and can make a concurrently-held account entity stale. That is why
   * lastSyncAt is written with a targeted UPDATE rather than a full entity save
   * — see updateLastSyncAt in the repository layer.
   */
  refreshAccessToken(account: MarketplaceAccountRow): Promise<void>;

  areCredentialsValid(account: MarketplaceAccountRow): Promise<boolean>;
}

// ── Connector ────────────────────────────────────────────────────────────────

export interface MarketplaceConnector {
  readonly marketplaceType: MarketplaceType;

  checkHealth(account: MarketplaceAccountRow): Promise<ConnectorHealthResult>;

  readonly authProvider: MarketplaceAuthProvider;

  // ── Listings ───────────────────────────────────────────────────────────────

  publishListing(
    account: MarketplaceAccountRow,
    product: ProductRow,
    request: PublishListingRequest,
  ): Promise<PublishListingResult>;

  updateListing(
    account: MarketplaceAccountRow,
    product: ProductRow,
    existingListing: MarketplaceListingRow,
    request: PublishListingRequest,
  ): Promise<PublishListingResult>;

  /** Must not throw if the listing is already gone on the external system. */
  delistListing(account: MarketplaceAccountRow, listing: MarketplaceListingRow): Promise<void>;

  // ── Inventory ──────────────────────────────────────────────────────────────

  syncInventory(
    account: MarketplaceAccountRow,
    listing: MarketplaceListingRow,
    newQuantity: number,
  ): Promise<InventorySyncResult>;

  // ── Orders ─────────────────────────────────────────────────────────────────

  importOrders(account: MarketplaceAccountRow, since: Date | null): Promise<ImportedOrder[]>;

  /** Returns null when the order cannot be found on the marketplace. */
  importOrder(
    account: MarketplaceAccountRow,
    externalOrderId: string,
  ): Promise<ImportedOrder | null>;
}

/**
 * Marks an error as retryable.
 *
 * The dispatcher and consumer use this to decide between the retry ladder and
 * an immediate permanent failure. Rate limits and 5xx are retryable; a rejected
 * payload is not, and retrying it five times just delays the operator finding
 * out that the listing is malformed.
 */
export class RetryableMarketplaceError extends Error {
  readonly retryable = true;
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'RetryableMarketplaceError';
    this.statusCode = statusCode;
  }
}

export class PermanentMarketplaceError extends Error {
  readonly retryable = false;
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'PermanentMarketplaceError';
    this.statusCode = statusCode;
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof PermanentMarketplaceError) return false;
  if (err instanceof RetryableMarketplaceError) return true;
  // Unknown failures are treated as retryable — a transient network blip is far
  // more likely than a deterministic bug, and the retry ladder is bounded.
  return true;
}
