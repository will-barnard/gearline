import { config } from '../../config.js';
import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { readCredentials } from '../../security/credential-encryptor.js';
import { apiRequest, isNotFound } from '../http.js';
import { PermanentMarketplaceError } from '../types.js';

const log = loggerFor('ebay-client');

/**
 * eBay Sell API client. Port of EbayApiClient.
 *
 * Covers the Inventory, Fulfillment, Account and Taxonomy APIs.
 *
 * ── The two-step listing model ───────────────────────────────────────────────
 *
 * eBay does not have a single "create listing" call. Publishing requires:
 *
 *   1. PUT  /inventory_item/{sku}        — the product (title, condition, images)
 *   2. POST /offer                        — the commercial terms (price, policies)
 *   3. POST /offer/{offerId}/publish      — makes it live, returns a listingId
 *
 * The inventory item is keyed by OUR SKU, which is what makes step 1 naturally
 * idempotent. Offers are keyed by an eBay-generated offerId that we must store.
 */

const MARKETPLACE_ID = 'EBAY_US';

function bearer(account: MarketplaceAccountRow): string {
  const credentials = readCredentials(account.encrypted_credentials);
  const token = credentials['access_token'];

  if (!token) {
    throw new PermanentMarketplaceError(`No access token for eBay account: ${account.id}`);
  }

  return token;
}

function url(path: string): string {
  return `${config.ebay.apiBaseUrl}${path}`;
}

// ── Inventory API ────────────────────────────────────────────────────────────

/**
 * Creates or replaces the inventory item for a SKU. Returns 204.
 *
 * Idempotent by SKU — safe to call repeatedly, which matters because publish
 * jobs retry.
 */
export async function createOrUpdateInventoryItem(
  account: MarketplaceAccountRow,
  sku: string,
  body: Record<string, unknown>,
): Promise<void> {
  await apiRequest({
    marketplace: 'eBay',
    method: 'PUT',
    url: url(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`),
    accessToken: bearer(account),
    headers: { 'content-language': 'en-US' },
    json: body,
  });
}

/**
 * Fetches the current inventory item, or null when it does not exist.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * PUT on this endpoint REPLACES the whole item, it does not merge. Sending a
 * quantity-only body would wipe the title, description, condition and images
 * off a live listing. So an inventory sync must read the existing item, merge
 * the new quantity into it, and PUT the complete body back.
 */
export async function getInventoryItem(
  account: MarketplaceAccountRow,
  sku: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await apiRequest<Record<string, unknown>>({
      marketplace: 'eBay',
      method: 'GET',
      url: url(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`),
      accessToken: bearer(account),
    });

    return response.body ?? null;
  } catch (err) {
    // Not yet created — the caller must send a full body rather than a merge.
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Creates an offer. Returns { offerId }.
 *
 * Content-Language is REQUIRED by eBay on offer create/update. Omitting it
 * produces an opaque 400 that does not mention the header.
 */
export async function createOffer(
  account: MarketplaceAccountRow,
  body: Record<string, unknown>,
): Promise<{ offerId?: string } | null> {
  const response = await apiRequest<{ offerId?: string }>({
    marketplace: 'eBay',
    method: 'POST',
    url: url('/sell/inventory/v1/offer'),
    accessToken: bearer(account),
    headers: { 'content-language': 'en-US' },
    json: body,
  });

  return response.body ?? null;
}

/** Updates an offer's price, policies or category. Returns 204. */
export async function updateOffer(
  account: MarketplaceAccountRow,
  offerId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await apiRequest({
    marketplace: 'eBay',
    method: 'PUT',
    url: url(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`),
    accessToken: bearer(account),
    headers: { 'content-language': 'en-US' },
    json: body,
  });
}

/** Publishes an offer, making it live. Returns { listingId }. */
export async function publishOffer(
  account: MarketplaceAccountRow,
  offerId: string,
): Promise<{ listingId?: string } | null> {
  const response = await apiRequest<{ listingId?: string }>({
    marketplace: 'eBay',
    method: 'POST',
    url: url(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`),
    accessToken: bearer(account),
  });

  return response.body ?? null;
}

/**
 * Withdraws (ends) an offer.
 *
 * A 404 resolves rather than throwing — the listing is already gone, which is
 * the desired end state. Without this, a listing ended manually on eBay would
 * fail every delist retry and then dead-letter.
 */
export async function withdrawOffer(
  account: MarketplaceAccountRow,
  offerId: string,
): Promise<void> {
  try {
    await apiRequest({
      marketplace: 'eBay',
      method: 'POST',
      url: url(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`),
      accessToken: bearer(account),
    });
  } catch (err) {
    if (isNotFound(err)) {
      log.info({ offerId }, 'eBay offer already gone — treating as withdrawn');
      return;
    }
    throw err;
  }
}

// ── Fulfillment API ──────────────────────────────────────────────────────────

export interface EbayOrdersResponse {
  total?: number;
  orders?: Array<Record<string, unknown>>;
  next?: string;
}

/** Fetches orders created since an ISO-8601 timestamp, 50 per page. */
export async function getOrders(
  account: MarketplaceAccountRow,
  since: string,
  offset: number,
): Promise<EbayOrdersResponse | null> {
  const response = await apiRequest<EbayOrdersResponse>({
    marketplace: 'eBay',
    method: 'GET',
    url: url('/sell/fulfillment/v1/order'),
    accessToken: bearer(account),
    query: { filter: `creationdate:[${since}..]`, limit: 50, offset },
  });

  return response.body ?? null;
}

export async function getOrder(
  account: MarketplaceAccountRow,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await apiRequest<Record<string, unknown>>({
      marketplace: 'eBay',
      method: 'GET',
      url: url(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`),
      accessToken: bearer(account),
    });

    return response.body ?? null;
  } catch (err) {
    if (isNotFound(err)) {
      log.warn({ orderId }, 'eBay order not found');
      return null;
    }
    throw err;
  }
}

/**
 * Creates a shipping fulfillment, marking the order shipped.
 *
 * `lineItems` entries are { lineItemId, quantity }, where lineItemId is eBay's
 * own line ID captured at import time into OrderLineItem.externalListingId.
 * eBay rejects the call without them, which is why an order imported before
 * that field was populated cannot be marked shipped.
 */
export async function markOrderShipped(
  account: MarketplaceAccountRow,
  orderId: string,
  lineItems: Array<{ lineItemId: string; quantity: number }>,
  trackingNumber: string | null,
  carrier: string | null,
  shippedDate: string,
): Promise<void> {
  await apiRequest({
    marketplace: 'eBay',
    method: 'POST',
    url: url(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shippingFulfillment`),
    accessToken: bearer(account),
    json: {
      lineItems,
      shippedDate,
      shippingCarrierCode: carrier ?? 'OTHER',
      trackingNumber: trackingNumber ?? '',
    },
  });
}

// ── Account API — locations and policies ─────────────────────────────────────

export async function getMerchantLocations(
  account: MarketplaceAccountRow,
): Promise<Array<Record<string, unknown>>> {
  const response = await apiRequest<{ locations?: Array<Record<string, unknown>> }>({
    marketplace: 'eBay',
    method: 'GET',
    url: url('/sell/inventory/v1/location'),
    accessToken: bearer(account),
  });

  return response.body?.locations ?? [];
}

/**
 * Creates a merchant location. Returns 204.
 *
 * eBay requires at least one location on every offer before it can be
 * published, so this is part of first-time setup rather than an optional extra.
 */
export async function createMerchantLocation(
  account: MarketplaceAccountRow,
  merchantLocationKey: string,
  name: string,
  addressLine1: string | null,
  city: string | null,
  stateOrProvince: string | null,
  postalCode: string | null,
): Promise<void> {
  const address: Record<string, unknown> = {};

  if (addressLine1?.trim()) address['addressLine1'] = addressLine1.trim();
  if (city?.trim()) address['city'] = city.trim();
  if (stateOrProvince?.trim()) address['stateOrProvince'] = stateOrProvince.trim().toUpperCase();
  if (postalCode?.trim()) address['postalCode'] = postalCode.trim();
  address['country'] = 'US';

  await apiRequest({
    marketplace: 'eBay',
    method: 'POST',
    url: url(`/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey.trim())}`),
    accessToken: bearer(account),
    json: {
      location: { address },
      locationTypes: ['WAREHOUSE'],
      name: name.trim(),
      merchantLocationStatus: 'ENABLED',
    },
  });
}

export async function getFulfillmentPolicies(
  account: MarketplaceAccountRow,
): Promise<Array<Record<string, unknown>>> {
  const response = await apiRequest<{ fulfillmentPolicies?: Array<Record<string, unknown>> }>({
    marketplace: 'eBay',
    method: 'GET',
    url: url('/sell/account/v1/fulfillment_policy'),
    accessToken: bearer(account),
    query: { marketplace_id: MARKETPLACE_ID },
  });

  return response.body?.fulfillmentPolicies ?? [];
}

export async function getReturnPolicies(
  account: MarketplaceAccountRow,
): Promise<Array<Record<string, unknown>>> {
  const response = await apiRequest<{ returnPolicies?: Array<Record<string, unknown>> }>({
    marketplace: 'eBay',
    method: 'GET',
    url: url('/sell/account/v1/return_policy'),
    accessToken: bearer(account),
    query: { marketplace_id: MARKETPLACE_ID },
  });

  return response.body?.returnPolicies ?? [];
}

// ── Taxonomy API ─────────────────────────────────────────────────────────────

/** Category tree 0 is eBay US. */
export async function getCategorySuggestions(
  account: MarketplaceAccountRow,
  query: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await apiRequest<{ categorySuggestions?: Array<Record<string, unknown>> }>({
    marketplace: 'eBay',
    method: 'GET',
    url: url('/commerce/taxonomy/v1/category_tree/0/get_category_suggestions'),
    accessToken: bearer(account),
    query: { category_name: query },
  });

  return response.body?.categorySuggestions ?? [];
}

/** Health check — cheap authenticated call. */
export async function verifyToken(account: MarketplaceAccountRow): Promise<boolean> {
  try {
    await getMerchantLocations(account);
    return true;
  } catch {
    return false;
  }
}
