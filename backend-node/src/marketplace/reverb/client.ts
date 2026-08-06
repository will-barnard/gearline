import { config } from '../../config.js';
import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { readCredentials } from '../../security/credential-encryptor.js';
import { apiRequest, isNotFound } from '../http.js';
import { PermanentMarketplaceError } from '../types.js';
import type {
  ReverbListingDto,
  ReverbOrderDto,
  ReverbOrdersResponse,
  ReverbShopResponse,
} from './types.js';

const log = loggerFor('reverb-client');

/**
 * Low-level Reverb HTTP client. Port of ReverbApiClient.
 *
 * Reverb pins its API version with an `Accept-Version: 3.0` header rather than
 * a URL path segment. Omitting it silently gets you an older schema with
 * different field names, so it is set on every request.
 */
const ACCEPT_VERSION = '3.0';

function baseHeaders(): Record<string, string> {
  return { 'accept-version': ACCEPT_VERSION };
}

function getAccessToken(account: MarketplaceAccountRow): string {
  const credentials = readCredentials(account.encrypted_credentials);
  const token = credentials['access_token'];

  if (!token) {
    // Permanent, not retryable — no amount of retrying conjures a token. The
    // operator needs to reconnect the account.
    throw new PermanentMarketplaceError(`No Reverb access token for account: ${account.id}`);
  }

  return token;
}

function url(path: string): string {
  return `${config.reverb.apiBaseUrl}${path}`;
}

export async function createListing(
  account: MarketplaceAccountRow,
  body: Record<string, unknown>,
): Promise<ReverbListingDto> {
  const response = await apiRequest<ReverbListingDto>({
    marketplace: 'Reverb',
    method: 'POST',
    url: url('/listings'),
    accessToken: getAccessToken(account),
    headers: baseHeaders(),
    json: body,
  });

  return response.body ?? {};
}

export async function updateListing(
  account: MarketplaceAccountRow,
  listingId: string,
  body: Record<string, unknown>,
): Promise<ReverbListingDto> {
  const response = await apiRequest<ReverbListingDto>({
    marketplace: 'Reverb',
    method: 'PUT',
    url: url(`/listings/${encodeURIComponent(listingId)}`),
    accessToken: getAccessToken(account),
    headers: baseHeaders(),
    json: body,
  });

  return response.body ?? {};
}

/**
 * Ends a listing. Idempotent: a 404 means it is already gone, which is the
 * outcome we wanted, so it resolves rather than throwing.
 *
 * This matters because delist jobs retry. Without the 404 tolerance, a listing
 * ended manually on Reverb would fail every retry and then dead-letter, marking
 * a perfectly fine listing as FAILED.
 */
export async function endListing(
  account: MarketplaceAccountRow,
  listingId: string,
): Promise<void> {
  try {
    await apiRequest({
      marketplace: 'Reverb',
      method: 'PUT',
      url: url(`/listings/${encodeURIComponent(listingId)}/state/end`),
      accessToken: getAccessToken(account),
      headers: baseHeaders(),
    });
  } catch (err) {
    if (isNotFound(err)) {
      log.info({ listingId }, 'Reverb listing already ended or not found — treating as success');
      return;
    }
    throw err;
  }
}

/**
 * Updates inventory quantity for a listing.
 *
 * ── Inconsistency carried over from the Java client ──────────────────────────
 *
 * This sends a NESTED body: { inventory: { total: n } }
 * while createListing sends a FLAT one: { has_inventory: true, inventory: n }
 *
 * Those two disagree, and ReverbListingMapper's comment explicitly says the
 * flat form is correct ("NOT a nested object"). The nested form here is
 * therefore suspect — it may be silently ignored by Reverb, which would mean
 * inventory sync has never actually worked on this path.
 *
 * It is reproduced faithfully rather than "fixed", because changing it is a
 * behavioural change that needs verifying against a real Reverb listing, not a
 * guess made during a port. See MIGRATION.md — flagged for follow-up.
 */
export async function updateInventory(
  account: MarketplaceAccountRow,
  listingId: string,
  quantity: number,
): Promise<void> {
  await apiRequest({
    marketplace: 'Reverb',
    method: 'PUT',
    url: url(`/listings/${encodeURIComponent(listingId)}`),
    accessToken: getAccessToken(account),
    headers: baseHeaders(),
    json: { inventory: { total: quantity } },
  });
}

export async function getOrders(
  account: MarketplaceAccountRow,
  createdAfter: string,
  page: number,
): Promise<ReverbOrderDto[]> {
  const response = await apiRequest<ReverbOrdersResponse>({
    marketplace: 'Reverb',
    method: 'GET',
    url: url('/my/orders/selling/all'),
    accessToken: getAccessToken(account),
    headers: baseHeaders(),
    query: { created_after: createdAfter, page, per_page: 50 },
  });

  return response.body?.orders ?? [];
}

/** Returns null when the order does not exist, rather than throwing. */
export async function getOrder(
  account: MarketplaceAccountRow,
  orderId: string,
): Promise<ReverbOrderDto | null> {
  try {
    const response = await apiRequest<ReverbOrderDto>({
      marketplace: 'Reverb',
      method: 'GET',
      url: url(`/my/orders/selling/${encodeURIComponent(orderId)}`),
      accessToken: getAccessToken(account),
      headers: baseHeaders(),
    });

    return response.body ?? null;
  } catch (err) {
    if (isNotFound(err)) {
      log.warn({ orderId }, 'Reverb order not found');
      return null;
    }
    throw err;
  }
}

/**
 * Fetches the seller's shipping profiles.
 *
 * These are NOT at their own endpoint — they are embedded in the shop response
 * at GET /shop -> shipping_profiles[]. Each profile's `id` is what must be sent
 * as `shipping_profile_id` when creating a listing.
 */
export async function getShippingProfiles(
  account: MarketplaceAccountRow,
): Promise<Array<{ id: string; name: string }>> {
  const response = await apiRequest<ReverbShopResponse>({
    marketplace: 'Reverb',
    method: 'GET',
    url: url('/shop'),
    accessToken: getAccessToken(account),
    headers: baseHeaders(),
  });

  const profiles = response.body?.shipping_profiles ?? [];

  return profiles
    .filter((p) => p.id !== undefined && p.name !== undefined)
    .map((p) => ({ id: String(p.id), name: String(p.name) }));
}

/** Health check. Returns false rather than throwing on any failure. */
export async function verifyToken(account: MarketplaceAccountRow): Promise<boolean> {
  try {
    await apiRequest({
      marketplace: 'Reverb',
      method: 'GET',
      url: url('/my/account'),
      accessToken: getAccessToken(account),
      headers: baseHeaders(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Marks an order shipped with tracking info.
 *
 * POST /my/orders/{id}/ship
 * Body: { shipment: { tracking_number, provider } }
 */
export async function markOrderShipped(
  account: MarketplaceAccountRow,
  orderId: string,
  trackingNumber: string | null,
  carrier: string | null,
): Promise<void> {
  await apiRequest({
    marketplace: 'Reverb',
    method: 'POST',
    url: url(`/my/orders/${encodeURIComponent(orderId)}/ship`),
    accessToken: getAccessToken(account),
    headers: baseHeaders(),
    json: {
      shipment: {
        tracking_number: trackingNumber ?? '',
        provider: carrier ?? 'Other',
      },
    },
  });
}
