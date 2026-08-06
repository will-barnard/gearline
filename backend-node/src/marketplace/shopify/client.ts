import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { readCredentials } from '../../security/credential-encryptor.js';
import { apiRequest } from '../http.js';
import { PermanentMarketplaceError } from '../types.js';

const log = loggerFor('shopify-client');

/**
 * Shopify Admin REST API client. Port of ShopifyApiClient.
 *
 * Unlike Reverb, each store has its own subdomain, so the base URL is derived
 * per-account from `external_shop_url`.
 *
 * Auth is a static token in the `X-Shopify-Access-Token` header — NOT a Bearer
 * token. Shopify tokens do not expire; they are revoked only by uninstalling
 * the app.
 */

/** Shopify versions quarterly. Bumping this needs a changelog review. */
export const API_VERSION = '2024-10';

/**
 * Extracts the `page_info` cursor from a Link header.
 *
 * Shopify signals more pages with:
 *   <https://shop.myshopify.com/admin/api/...?page_info=XYZ>; rel="next"
 *
 * The cursor must be used verbatim — Shopify's cursors encode filter state, so
 * reconstructing the query from your own parameters silently returns a
 * different result set.
 */
const NEXT_PAGE_INFO = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/;

export interface ShopifyProductsPage {
  products: unknown[];
  nextPageInfo: string | null;
}

function accessToken(account: MarketplaceAccountRow): string {
  const credentials = readCredentials(account.encrypted_credentials);
  const token = credentials['access_token'];

  if (!token) {
    throw new PermanentMarketplaceError(`No access token for Shopify account: ${account.id}`);
  }

  return token;
}

/** Normalises `mystore.myshopify.com` or `https://mystore.myshopify.com/` to an origin. */
function baseUrl(account: MarketplaceAccountRow): string {
  const shopUrl = account.external_shop_url;

  if (!shopUrl || shopUrl.trim() === '') {
    throw new PermanentMarketplaceError(`No shop URL configured for account ${account.id}`);
  }

  const trimmed = shopUrl.replace(/\/+$/, '');
  return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
}

function adminUrl(account: MarketplaceAccountRow, path: string): string {
  return `${baseUrl(account)}/admin/api/${API_VERSION}${path}`;
}

function shopifyHeaders(account: MarketplaceAccountRow): Record<string, string> {
  return { 'x-shopify-access-token': accessToken(account) };
}

// ── Orders ───────────────────────────────────────────────────────────────────

export async function createOrder(
  account: MarketplaceAccountRow,
  orderBody: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const response = await apiRequest<Record<string, unknown>>({
    marketplace: 'Shopify',
    method: 'POST',
    url: adminUrl(account, '/orders.json'),
    headers: shopifyHeaders(account),
    json: orderBody,
  });

  return response.body ?? null;
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

export async function registerWebhook(
  account: MarketplaceAccountRow,
  topic: string,
  endpoint: string,
): Promise<Record<string, unknown> | null> {
  const response = await apiRequest<Record<string, unknown>>({
    marketplace: 'Shopify',
    method: 'POST',
    url: adminUrl(account, '/webhooks.json'),
    headers: shopifyHeaders(account),
    json: { webhook: { topic, address: endpoint, format: 'json' } },
  });

  return response.body ?? null;
}

// ── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Exchanges an authorisation code for a permanent access token.
 *
 * Note this does NOT go through adminUrl — the OAuth endpoint sits outside the
 * versioned /admin/api path, and there is no account row yet to read a token
 * from.
 */
export async function exchangeCodeForToken(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<{ access_token?: string; scope?: string } | null> {
  const domain = shopDomain.replace(/\/+$/, '');
  const origin = domain.startsWith('http') ? domain : `https://${domain}`;

  const response = await apiRequest<{ access_token?: string; scope?: string }>({
    marketplace: 'Shopify',
    method: 'POST',
    url: `${origin}/admin/oauth/access_token`,
    json: { client_id: clientId, client_secret: clientSecret, code },
  });

  return response.body ?? null;
}

// ── Products ─────────────────────────────────────────────────────────────────

/**
 * Fetches one page of active products.
 *
 * Cursor pagination: omit `pageInfo` for the first call, then pass the previous
 * response's `nextPageInfo` until it comes back null.
 *
 * Note the query-parameter asymmetry, which is a Shopify constraint rather than
 * an oversight: the first request may filter with `status=active`, but
 * subsequent cursor requests must send ONLY `page_info` and `limit`. Including
 * the filter alongside a cursor is rejected with a 400.
 */
export async function fetchProducts(
  account: MarketplaceAccountRow,
  pageInfo: string | null,
): Promise<ShopifyProductsPage> {
  const query = pageInfo
    ? { limit: 250, page_info: pageInfo }
    : { limit: 250, status: 'active' };

  const response = await apiRequest<{ products?: unknown[] }>({
    marketplace: 'Shopify',
    method: 'GET',
    url: adminUrl(account, '/products.json'),
    headers: shopifyHeaders(account),
    query,
    includeResponseHeaders: true,
  });

  const linkHeader = response.headers?.['link'];
  const link = Array.isArray(linkHeader) ? linkHeader.join(',') : linkHeader;

  const nextPageInfo = link ? (NEXT_PAGE_INFO.exec(link)?.[1] ?? null) : null;
  const products = response.body?.products ?? [];

  log.debug({ count: products.length, hasNextPage: nextPageInfo !== null }, 'Fetched Shopify products');

  return { products, nextPageInfo };
}

export async function fetchProduct(
  account: MarketplaceAccountRow,
  shopifyProductId: string,
): Promise<Record<string, unknown> | null> {
  const response = await apiRequest<{ product?: Record<string, unknown> }>({
    marketplace: 'Shopify',
    method: 'GET',
    url: adminUrl(account, `/products/${encodeURIComponent(shopifyProductId)}.json`),
    headers: shopifyHeaders(account),
  });

  return response.body?.product ?? null;
}

/**
 * Fetches a product's metafields.
 *
 * Best-effort by design: returns [] on ANY failure rather than throwing.
 * Metafields carry optional enrichment (reverb_model, youtube_url, condition
 * notes), so a metafield outage should degrade listing quality, not block a
 * product sync outright.
 */
export async function fetchProductMetafields(
  account: MarketplaceAccountRow,
  shopifyProductId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const response = await apiRequest<{ metafields?: Array<Record<string, unknown>> }>({
      marketplace: 'Shopify',
      method: 'GET',
      url: adminUrl(account, `/products/${encodeURIComponent(shopifyProductId)}/metafields.json`),
      headers: shopifyHeaders(account),
    });

    return response.body?.metafields ?? [];
  } catch (err) {
    log.warn({ err, shopifyProductId }, 'Could not fetch Shopify metafields — continuing without them');
    return [];
  }
}

// ── Inventory ────────────────────────────────────────────────────────────────

/**
 * Sets absolute available quantity for an inventory item at a location.
 *
 * `set` rather than `adjust`: adjust is relative and non-idempotent, so a
 * retried job would deduct twice. Inventory sync jobs DO retry.
 */
export async function setInventoryLevel(
  account: MarketplaceAccountRow,
  inventoryItemId: string,
  locationId: string,
  available: number,
): Promise<void> {
  await apiRequest({
    marketplace: 'Shopify',
    method: 'POST',
    url: adminUrl(account, '/inventory_levels/set.json'),
    headers: shopifyHeaders(account),
    json: {
      inventory_item_id: Number(inventoryItemId),
      location_id: Number(locationId),
      available,
    },
  });
}

/** Verifies the stored token still works. Used by checkHealth. */
export async function verifyToken(account: MarketplaceAccountRow): Promise<boolean> {
  try {
    await apiRequest({
      marketplace: 'Shopify',
      method: 'GET',
      url: adminUrl(account, '/shop.json'),
      headers: shopifyHeaders(account),
    });
    return true;
  } catch {
    return false;
  }
}
