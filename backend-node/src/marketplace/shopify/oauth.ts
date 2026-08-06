import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { config } from '../../config.js';
import { db, sql } from '../../db/index.js';
import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { encrypt } from '../../security/credential-encryptor.js';
import * as client from './client.js';

const log = loggerFor('shopify-oauth');

/**
 * Shopify OAuth install and callback. Port of ShopifyOAuthController.
 *
 * ── Two different HMAC schemes, do not confuse them ──────────────────────────
 *
 * WEBHOOKS  (webhook-validator.ts): Base64 HMAC-SHA256 over the raw request
 *           BODY, delivered in the X-Shopify-Hmac-Sha256 header.
 *
 * OAUTH     (here): HEX HMAC-SHA256 over the sorted QUERY STRING with the
 *           `hmac` parameter removed, delivered as the `hmac` query parameter.
 *
 * Different encoding, different input, different transport. Reusing one for the
 * other silently rejects every request.
 */

const NONCE_EXPIRY_MS = 600_000; // 10 minutes

const WEBHOOK_TOPICS = [
  'products/create',
  'products/update',
  'inventory_levels/update',
  'orders/create',
  'fulfillments/create',
] as const;

/**
 * Single-use OAuth nonces.
 *
 * In-memory, matching the Java implementation — adequate for a single
 * container. Note the limitation: with more than one replica, an install
 * started on instance A and called back on instance B fails the nonce check.
 * Beachhead's blue/green swap also drops pending nonces mid-deploy, so an
 * install in flight during a deploy has to be restarted. Move to Postgres if
 * either becomes a problem.
 */
const pendingNonces = new Map<string, number>();

function evictExpiredNonces(): void {
  const now = Date.now();
  for (const [nonce, expiry] of pendingNonces) {
    if (now > expiry) pendingNonces.delete(nonce);
  }
}

/**
 * Rejects anything that is not a real .myshopify.com domain.
 *
 * This is an open-redirect guard, not a formatting nicety: `shop` is
 * interpolated into the URL we redirect the merchant's browser to. Without it,
 * an attacker could craft an install link that bounces the merchant to a
 * phishing page carrying our branding.
 */
export function isValidShopDomain(shop: string | undefined): shop is string {
  if (!shop) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

/**
 * Verifies the callback HMAC.
 *
 * Per Shopify's spec:
 *   1. Drop the `hmac` parameter
 *   2. Sort the remaining key=value pairs by key
 *   3. Join with "&"
 *   4. HMAC-SHA256 with the client secret, hex-encoded
 *
 * The raw query string is used WITHOUT URL-decoding, because Shopify computes
 * the signature over the encoded form. Decoding first produces a different
 * message and fails every check.
 */
export function isValidOAuthHmac(rawQueryString: string, receivedHmac: string): boolean {
  const clientSecret = config.shopify.clientSecret;

  if (!clientSecret || clientSecret.trim() === '') {
    log.warn('SHOPIFY_CLIENT_SECRET is not configured — OAuth HMAC validation SKIPPED');
    return true;
  }

  if (!receivedHmac) return false;

  const params: Array<[string, string]> = [];

  for (const pair of rawQueryString.split('&')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;

    const key = pair.slice(0, idx);
    if (key === 'hmac') continue;

    params.push([key, pair.slice(idx + 1)]);
  }

  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const message = params.map(([k, v]) => `${k}=${v}`).join('&');
  const computed = createHmac('sha256', clientSecret).update(message, 'utf8').digest('hex');

  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(receivedHmac, 'utf8');

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Step 1: install ──────────────────────────────────────────────────────────

export function buildInstallUrl(shop: string): string {
  const nonce = randomUUID().replace(/-/g, '');

  pendingNonces.set(nonce, Date.now() + NONCE_EXPIRY_MS);
  evictExpiredNonces();

  const params = new URLSearchParams({
    client_id: config.shopify.clientId,
    scope: config.shopify.scopes,
    redirect_uri: buildRedirectUri(),
    state: nonce,
  });

  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

export function buildRedirectUri(): string {
  const base = config.app.baseUrl;

  if (!base || base.trim() === '') {
    throw new Error('APP_BASE_URL is not configured — cannot build the Shopify OAuth redirect URI');
  }

  return `${base.replace(/\/+$/, '')}/api/v1/marketplace/shopify/oauth/callback`;
}

/** Consumes a nonce. Returns false if unknown or expired — single use. */
export function consumeNonce(state: string): boolean {
  const expiry = pendingNonces.get(state);
  pendingNonces.delete(state);

  if (expiry === undefined) return false;
  return Date.now() <= expiry;
}

// ── Step 2: callback ─────────────────────────────────────────────────────────

export interface CallbackResult {
  success: boolean;
  error?: string;
  account?: MarketplaceAccountRow;
}

/**
 * Exchanges the code for a token and upserts the account.
 *
 * Idempotent on shop domain, so re-connecting an existing store updates its
 * credentials rather than creating a duplicate account.
 */
export async function completeCallback(shop: string, code: string): Promise<CallbackResult> {
  let tokenResponse;

  try {
    tokenResponse = await client.exchangeCodeForToken(
      shop,
      config.shopify.clientId,
      config.shopify.clientSecret,
      code,
    );
  } catch (err) {
    log.error({ err, shop }, 'Shopify token exchange failed');
    return { success: false, error: 'Token exchange failed' };
  }

  const accessToken = tokenResponse?.access_token;

  if (!accessToken || accessToken.trim() === '') {
    log.error({ shop }, 'Shopify token exchange returned no access_token');
    return { success: false, error: 'No access token returned' };
  }

  const credentials = encrypt({ access_token: accessToken, scope: tokenResponse?.scope ?? '' });

  const existing = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('external_account_id', '=', shop)
    .executeTakeFirst();

  let account: MarketplaceAccountRow | undefined;

  if (existing) {
    account = await db
      .updateTable('marketplace_accounts')
      .set({
        display_name: shop,
        external_shop_url: shop,
        connection_status: 'CONNECTED',
        active: true,
        last_error: null,
        encrypted_credentials: credentials,
        version: sql<string>`version + 1`,
        updated_at: new Date(),
      })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirst();
  } else {
    account = await db
      .insertInto('marketplace_accounts')
      .values({
        marketplace_type: 'SHOPIFY',
        display_name: shop,
        external_account_id: shop,
        external_shop_url: shop,
        connection_status: 'CONNECTED',
        active: true,
        encrypted_credentials: credentials,
        sync_settings: sql`'{}'::jsonb`,
      })
      // Two callbacks racing for the same shop would otherwise both insert.
      .onConflict((oc) =>
        oc.column('external_account_id').doUpdateSet({
          encrypted_credentials: credentials,
          connection_status: 'CONNECTED',
          active: true,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirst();
  }

  if (!account) {
    return { success: false, error: 'Failed to save the marketplace account' };
  }

  log.info({ shop, accountId: account.id }, 'Shopify account connected');

  // Fire-and-forget: a webhook registration failure must not fail the install.
  // The store is connected; webhooks can be re-registered by reconnecting.
  try {
    await registerWebhooks(account);
  } catch (err) {
    log.error({ err, shop }, 'Webhook registration failed — store is still connected');
  }

  return { success: true, account };
}

/** Where the merchant's browser lands after the handshake. */
export function frontendRedirectUrl(success: boolean, error?: string): string {
  const base = (config.app.baseUrl || 'http://localhost:5173').replace(/\/+$/, '');

  const params = new URLSearchParams({ shopify_connected: success ? 'true' : 'false' });
  if (error) params.set('error', error);

  return `${base}/marketplaces?${params.toString()}`;
}

// ── Webhook registration ─────────────────────────────────────────────────────

/**
 * Registers every topic Gearline needs.
 *
 * Shopify deduplicates by topic+address, so re-running this is safe.
 * Individual failures are logged and skipped rather than aborting the rest —
 * losing one topic is better than losing all of them.
 */
export async function registerWebhooks(account: MarketplaceAccountRow): Promise<void> {
  const baseUrl = config.app.baseUrl;

  if (!baseUrl || baseUrl.trim() === '') {
    log.warn(
      'APP_BASE_URL is not configured — cannot register Shopify webhooks. ' +
        'Set it to the public-facing URL and reconnect the store.',
    );
    return;
  }

  for (const topic of WEBHOOK_TOPICS) {
    const endpoint = `${baseUrl.replace(/\/+$/, '')}${topicToPath(topic)}`;

    try {
      await client.registerWebhook(account, topic, endpoint);
      log.info({ topic, endpoint }, 'Registered Shopify webhook');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('already been taken')) {
        log.info({ topic, endpoint }, 'Shopify webhook already registered — skipping');
      } else if (message.includes('Invalid topic') || message.includes('missing access scope')) {
        // Actionable and easy to miss otherwise: the app is missing a scope.
        log.warn(
          { topic },
          'Shopify webhook could not be registered — missing access scope. Grant it in the ' +
            'Partners Dashboard and reconnect the store.',
        );
      } else {
        log.error({ err, topic }, 'Failed to register Shopify webhook');
      }
    }
  }
}

/**
 * Topic → our endpoint path.
 *
 * Only inventory_levels differs: the topic uses an underscore, our route uses a
 * hyphen. Everything else maps straight through.
 */
function topicToPath(topic: string): string {
  if (topic === 'inventory_levels/update') return '/webhooks/shopify/inventory-levels/update';
  return `/webhooks/shopify/${topic}`;
}
