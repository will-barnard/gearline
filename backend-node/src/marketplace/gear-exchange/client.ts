import { config } from '../../config.js';
import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { readCredentials } from '../../security/credential-encryptor.js';
import { apiRequest, isNotFound, type ApiRequestOptions } from '../http.js';
import { PermanentMarketplaceError, RetryableMarketplaceError } from '../types.js';
import type {
  GxImageDto,
  GxListingDto,
  GxListingEnvelope,
  GxOption,
  GxOrderDto,
} from './types.js';

const log = loggerFor('gx-client');

/**
 * Low-level Gear Exchange HTTP client.
 *
 * Auth is a static bearer token per account, generated on Gear Exchange under
 * Sold Items → API Settings. There is no OAuth and no refresh: a token works
 * until the seller deletes it. It lives in the account's encrypted credentials
 * under `access_token`, the same key Reverb's PAT uses, so the generic
 * "create account" endpoint handles both.
 *
 * ── The image-processing lock ────────────────────────────────────────────────
 *
 * Creating a listing, or adding images to one, starts an asynchronous image
 * import. Until it finishes, Gear Exchange BLOCKS update, publish, deactivate
 * and delete on that listing. The docs do not say which status code the block
 * returns, so `write()` below reclassifies any rejection that reads like it
 * (409/423, or a message mentioning images being processed) as RETRYABLE.
 * Without that, a price change arriving a few seconds after a publish would be
 * recorded as a permanent failure instead of simply succeeding on retry.
 */

export const MARKETPLACE = 'Gear Exchange';

/** Resolved per call rather than at import, so tests can point it elsewhere. */
function baseUrl(): string {
  return (config.gearExchange.apiBaseUrl || 'https://www.sweetwater.com/used/public-api/v1').replace(
    /\/+$/,
    '',
  );
}

function url(path: string): string {
  return `${baseUrl()}${path}`;
}

export function getAccessToken(account: MarketplaceAccountRow): string {
  const token = readCredentials(account.encrypted_credentials)['access_token'];

  if (!token) {
    // Permanent — retrying cannot conjure a token. The operator must reconnect.
    throw new PermanentMarketplaceError(
      `No Gear Exchange API token for account ${account.id}. Reconnect it on the Marketplaces page.`,
    );
  }

  return token;
}

type RequestOpts = Omit<ApiRequestOptions, 'marketplace' | 'accessToken' | 'url'> & { path: string };

async function call<T>(account: MarketplaceAccountRow, opts: RequestOpts): Promise<T> {
  const { path, ...rest } = opts;
  const response = await apiRequest<T>({
    ...rest,
    marketplace: MARKETPLACE,
    url: url(path),
    accessToken: getAccessToken(account),
    // The docs list Content-Type as REQUIRED on every request, GETs included,
    // and answer 415 when it is missing. apiRequest only sets it when there is
    // a body, so it is forced here.
    headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) },
  });
  return response.body;
}

/** True when a rejection is the image-processing lock rather than a real error. */
export function isImageProcessingLock(err: unknown): boolean {
  if (!(err instanceof PermanentMarketplaceError)) return false;
  if (err.statusCode === 409 || err.statusCode === 423) return true;

  const text = `${err.responseBody ?? ''} ${err.message}`.toLowerCase();
  return /image/.test(text) && /process/.test(text);
}

/** A write that may hit the image-processing lock. See the class note. */
async function write<T>(account: MarketplaceAccountRow, opts: RequestOpts): Promise<T> {
  try {
    return await call<T>(account, opts);
  } catch (err) {
    if (isImageProcessingLock(err)) {
      const e = err as PermanentMarketplaceError;
      log.info({ path: opts.path }, 'Gear Exchange listing is still processing images — will retry');
      throw new RetryableMarketplaceError(
        `Gear Exchange is still processing this listing's images: ${e.message}`,
        e.statusCode,
        e.responseBody,
      );
    }
    throw err;
  }
}

/**
 * Create and update return `{ message, listing }`; publish, deactivate and GET
 * return the listing bare. Accept either, the way the Reverb client does —
 * reading `id` off the wrong level is how a live listing gets recorded as a
 * failed publish.
 */
export function unwrapListing(body: unknown): GxListingDto {
  if (!body || typeof body !== 'object') return {};
  const envelope = body as GxListingEnvelope;
  if (envelope.listing && typeof envelope.listing === 'object') return envelope.listing;
  return body as GxListingDto;
}

/**
 * Normalises an options endpoint into {id, name} pairs.
 *
 * The docs name /categories, /conditions, /return-policies, /payout-options and
 * /shipping/providers but show no response bodies. This accepts an array of
 * objects, an array of scalars, a `{ data: [...] }` wrapper, or an id → name
 * map — whichever arrives — so the settings screen works without a guess
 * having to be exactly right.
 */
export function normaliseOptions(body: unknown): GxOption[] {
  let items: unknown = body;

  if (items && typeof items === 'object' && !Array.isArray(items)) {
    const obj = items as Record<string, unknown>;
    const wrapped = obj['data'] ?? obj['results'] ?? obj['items'];
    if (Array.isArray(wrapped)) {
      items = wrapped;
    } else {
      // Plain map: { "3": "Mint", ... }
      return Object.entries(obj)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([k, v]) => ({ id: k, name: String(v) }));
    }
  }

  if (!Array.isArray(items)) return [];

  const out: GxOption[] = [];

  for (const item of items) {
    if (typeof item === 'string' || typeof item === 'number') {
      out.push({ id: String(item), name: String(item) });
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    const o = item as Record<string, unknown>;
    const id = o['id'] ?? o['value'] ?? o['key'] ?? o['slug'] ?? o['days'];
    const name =
      o['fullName'] ?? o['full_name'] ?? o['name'] ?? o['label'] ?? o['title'] ?? o['displayName'] ?? o['display_name'] ?? id;

    if (id === undefined || id === null) continue;
    out.push({ id: String(id), name: String(name) });
  }

  return out;
}

// ── Health ───────────────────────────────────────────────────────────────────

export async function health(account: MarketplaceAccountRow): Promise<boolean> {
  const body = await call<{ health?: string }>(account, { method: 'GET', path: '/health' });
  return String(body?.health ?? '').toLowerCase() === 'ok';
}

// ── Listings ─────────────────────────────────────────────────────────────────

/** Returns null when the listing does not exist (deleted, or never ours). */
export async function getListing(
  account: MarketplaceAccountRow,
  listingId: string,
): Promise<GxListingDto | null> {
  try {
    const body = await call<unknown>(account, {
      method: 'GET',
      path: `/listings/${encodeURIComponent(listingId)}`,
    });
    return unwrapListing(body);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function createListing(
  account: MarketplaceAccountRow,
  body: Record<string, unknown>,
): Promise<GxListingDto> {
  const res = await call<unknown>(account, { method: 'POST', path: '/listings', json: body });
  return unwrapListing(res);
}

export async function updateListing(
  account: MarketplaceAccountRow,
  listingId: string,
  body: Record<string, unknown>,
): Promise<GxListingDto> {
  const res = await write<unknown>(account, {
    method: 'PUT',
    path: `/listings/${encodeURIComponent(listingId)}`,
    json: body,
  });
  return unwrapListing(res);
}

export async function publishListing(
  account: MarketplaceAccountRow,
  listingId: string,
): Promise<GxListingDto> {
  const res = await write<unknown>(account, {
    method: 'POST',
    path: `/listings/${encodeURIComponent(listingId)}/publish`,
  });
  return unwrapListing(res);
}

/**
 * Deactivate, not delete. A deactivated listing returns to `draft` and can be
 * republished with its photos and history intact; a deleted one is gone, images
 * and all. Gearline only ever deactivates.
 */
export async function deactivateListing(
  account: MarketplaceAccountRow,
  listingId: string,
): Promise<GxListingDto> {
  const res = await write<unknown>(account, {
    method: 'POST',
    path: `/listings/${encodeURIComponent(listingId)}/deactivate`,
  });
  return unwrapListing(res);
}

export async function getListingImages(
  account: MarketplaceAccountRow,
  listingId: string,
): Promise<GxImageDto[]> {
  const body = await call<unknown>(account, {
    method: 'GET',
    path: `/listings/${encodeURIComponent(listingId)}/images`,
  });
  return Array.isArray(body) ? (body as GxImageDto[]) : [];
}

// ── Reference data ───────────────────────────────────────────────────────────

export async function getCategories(account: MarketplaceAccountRow): Promise<GxOption[]> {
  return normaliseOptions(await call<unknown>(account, { method: 'GET', path: '/categories' }));
}

export async function getConditions(account: MarketplaceAccountRow): Promise<GxOption[]> {
  return normaliseOptions(await call<unknown>(account, { method: 'GET', path: '/conditions' }));
}

export async function getReturnPolicies(account: MarketplaceAccountRow): Promise<GxOption[]> {
  return normaliseOptions(await call<unknown>(account, { method: 'GET', path: '/return-policies' }));
}

export async function getPayoutOptions(account: MarketplaceAccountRow): Promise<GxOption[]> {
  return normaliseOptions(await call<unknown>(account, { method: 'GET', path: '/payout-options' }));
}

export async function getShippingProviders(account: MarketplaceAccountRow): Promise<GxOption[]> {
  return normaliseOptions(
    await call<unknown>(account, { method: 'GET', path: '/shipping/providers' }),
  );
}

// ── Orders ───────────────────────────────────────────────────────────────────

export const ORDERS_PER_PAGE = 50;

/**
 * One page of orders updated inside [start, end).
 *
 * The response body is not documented beyond "a list of multiple orders", so a
 * bare array and the common `{ data: [...] }` / `{ orders: [...] }` wrappers
 * are all accepted.
 */
export async function getOrders(
  account: MarketplaceAccountRow,
  page: number,
  updatedStartTime: string | undefined,
): Promise<GxOrderDto[]> {
  const body = await call<unknown>(account, {
    method: 'GET',
    path: '/orders',
    query: { page, resultsPerPage: ORDERS_PER_PAGE, updatedStartTime },
  });

  if (Array.isArray(body)) return body as GxOrderDto[];

  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    const list = obj['data'] ?? obj['orders'] ?? obj['results'];
    if (Array.isArray(list)) return list as GxOrderDto[];
  }

  log.warn({ keys: body && typeof body === 'object' ? Object.keys(body) : typeof body }, 'Unrecognised Gear Exchange orders response');
  return [];
}

export async function getOrder(
  account: MarketplaceAccountRow,
  orderId: string,
): Promise<GxOrderDto | null> {
  try {
    const body = await call<unknown>(account, {
      method: 'GET',
      path: `/orders/${encodeURIComponent(orderId)}`,
    });
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      // Tolerate a { data: {...} } / { order: {...} } wrapper as well as bare.
      const inner = obj['order'] ?? obj['data'];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as GxOrderDto;
      return body as GxOrderDto;
    }
    return null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** 204 on success. Accepts several tracking numbers for a multi-box shipment. */
export async function addTracking(
  account: MarketplaceAccountRow,
  orderId: string,
  shippingProvider: string,
  trackingNumbers: string[],
): Promise<void> {
  await call<unknown>(account, {
    method: 'POST',
    path: `/orders/${encodeURIComponent(orderId)}/tracking`,
    json: { shippingProvider, trackingNumbers },
  });
}

// ── Webhook configuration ────────────────────────────────────────────────────

/**
 * Points this seller's GX webhooks at Gearline. Needs a token with the
 * write_user scope; without it GX answers 403 and the seller can paste the
 * same URL and token into GX's "Set up webhooks" form instead.
 */
export async function setWebhookConfig(
  account: MarketplaceAccountRow,
  webhookUrl: string,
  bearerToken: string,
): Promise<void> {
  await call<unknown>(account, {
    method: 'POST',
    path: '/user/webhook-config',
    json: {
      url: webhookUrl,
      token: bearerToken,
      listing_status_change_notifications: true,
      order_status_change_notifications: true,
    },
  });
}
