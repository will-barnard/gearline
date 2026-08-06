import { config } from '../../config.js';
import { db, sql } from '../../db/index.js';
import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { encrypt, readCredentials } from '../../security/credential-encryptor.js';
import { apiRequest } from '../http.js';
import type { MarketplaceAuthProvider } from '../types.js';

const log = loggerFor('ebay-auth');

/**
 * eBay OAuth 2.0. Port of EbayAuthProvider.
 *
 * ── The RuName quirk ─────────────────────────────────────────────────────────
 *
 * eBay's `redirect_uri` parameter is NOT a URL. It is a "RuName" — a short
 * registered identifier like `YourApp-YourApp-12345-abcde` that you get from
 * the Developer Portal, where the real callback URL is configured separately.
 *
 * Passing an actual URL fails with an unhelpful invalid_request. This trips
 * up nearly everyone integrating eBay for the first time.
 *
 * ── Auth style ───────────────────────────────────────────────────────────────
 *
 * Token calls use HTTP Basic with base64(clientId:clientSecret), not a client
 * secret in the form body. Different from Reverb, which uses the body.
 *
 * Docs: https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant.html
 */

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

/**
 * Scopes.
 *
 * `sell.account.readonly` is required for the fulfillment_policy and
 * return_policy reads. Without it those calls 403 and the eBay settings
 * dropdowns come back empty with no obvious cause.
 */
const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
].join(' ');

/** Treat as expired 5 minutes early so a token cannot lapse mid-request. */
const EXPIRY_SKEW_MS = 300_000;

/** See the equivalent note in the Reverb provider — memoised in-flight promise. */
const inFlightRefreshes = new Map<string, Promise<void>>();

function basicAuthHeader(): string {
  const raw = `${config.ebay.clientId}:${config.ebay.clientSecret}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

function expiryTimestamp(expiresIn: number | string): number {
  const seconds = typeof expiresIn === 'number' ? expiresIn : Number.parseInt(expiresIn, 10);
  return Date.now() + (Number.isFinite(seconds) ? seconds : 0) * 1000;
}

function credentialsValid(account: MarketplaceAccountRow): boolean {
  const credentials = readCredentials(account.encrypted_credentials);

  if (!credentials['access_token']) return false;

  const expiresAt = credentials['expires_at'];
  if (!expiresAt) return true;

  const expiry = Number.parseInt(expiresAt, 10);
  if (!Number.isFinite(expiry)) return true;

  return Date.now() < expiry - EXPIRY_SKEW_MS;
}

export const ebayAuthProvider: MarketplaceAuthProvider = {
  /**
   * `redirectUri` here must be the RuName, not a URL. The caller supplies it
   * from config.ebay.ruName.
   */
  buildAuthorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: config.ebay.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: EBAY_SCOPES,
      state,
    });

    return `${config.ebay.authUrl}/authorize?${params.toString()}`;
  },

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<Record<string, string>> {
    const response = await apiRequest<{
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number | string;
    }>({
      marketplace: 'eBay',
      method: 'POST',
      url: TOKEN_URL,
      headers: { authorization: basicAuthHeader() },
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri, // the RuName
      },
    });

    const body = response.body;

    if (!body?.access_token) {
      throw new Error('Empty or invalid token response from eBay');
    }

    const credentials: Record<string, string> = {
      access_token: body.access_token,
      token_type: body.token_type ?? 'Bearer',
    };

    if (body.refresh_token) credentials['refresh_token'] = body.refresh_token;
    if (body.expires_in !== undefined) {
      credentials['expires_at'] = String(expiryTimestamp(body.expires_in));
    }

    return credentials;
  },

  async refreshAccessToken(account: MarketplaceAccountRow): Promise<void> {
    const existing = inFlightRefreshes.get(account.id);
    if (existing) {
      log.debug({ accountId: account.id }, 'Joining in-flight eBay token refresh');
      return existing;
    }

    const refresh = doRefresh(account).finally(() => {
      inFlightRefreshes.delete(account.id);
    });

    inFlightRefreshes.set(account.id, refresh);
    return refresh;
  },

  async areCredentialsValid(account: MarketplaceAccountRow): Promise<boolean> {
    return credentialsValid(account);
  },
};

async function doRefresh(account: MarketplaceAccountRow): Promise<void> {
  try {
    const fresh = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('id', '=', account.id)
      .executeTakeFirst();

    if (!fresh) {
      log.error({ accountId: account.id }, 'eBay account disappeared during refresh');
      return;
    }

    if (credentialsValid(fresh)) {
      log.debug({ accountId: account.id }, 'eBay token already valid — refreshed elsewhere');
      return;
    }

    const credentials = readCredentials(fresh.encrypted_credentials);
    const refreshToken = credentials['refresh_token'];

    if (!refreshToken) {
      log.warn({ accountId: account.id }, 'No refresh token for eBay account');
      await markTokenExpired(fresh);
      return;
    }

    const response = await apiRequest<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number | string;
    }>({
      marketplace: 'eBay',
      method: 'POST',
      url: TOKEN_URL,
      headers: { authorization: basicAuthHeader() },
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        // eBay requires the scope list on refresh as well as on the initial
        // grant. Omitting it silently narrows the token's scopes.
        scope: EBAY_SCOPES,
      },
    });

    const body = response.body;

    if (!body?.access_token) {
      log.error(
        { accountId: account.id, responseKeys: Object.keys(body ?? {}) },
        'eBay token refresh returned no access_token',
      );
      await markTokenExpired(fresh);
      return;
    }

    const updated: Record<string, string> = { ...credentials, access_token: body.access_token };

    if (body.refresh_token) updated['refresh_token'] = body.refresh_token;
    if (body.expires_in !== undefined) {
      updated['expires_at'] = String(expiryTimestamp(body.expires_in));
    }

    await persistCredentials(fresh, updated);
    log.info({ accountId: account.id }, 'Refreshed eBay access token');
  } catch (err) {
    log.error({ err, accountId: account.id }, 'eBay token refresh failed');

    const current = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('id', '=', account.id)
      .executeTakeFirst();

    if (current) await markTokenExpired(current);
  }
}

/** Optimistic-lock guarded write, with one retry. See the Reverb equivalent. */
async function persistCredentials(
  account: MarketplaceAccountRow,
  credentials: Record<string, string>,
): Promise<void> {
  const updated = await db
    .updateTable('marketplace_accounts')
    .set({
      encrypted_credentials: encrypt(credentials),
      connection_status: 'CONNECTED',
      last_error: null,
      version: sql<string>`version + 1`,
      updated_at: new Date(),
    })
    .where('id', '=', account.id)
    .where('version', '=', account.version)
    .returning('id')
    .executeTakeFirst();

  if (updated) return;

  log.warn({ accountId: account.id }, 'Optimistic lock conflict saving eBay credentials — retrying');

  const fresh = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('id', '=', account.id)
    .executeTakeFirst();

  if (!fresh) return;

  if (credentialsValid(fresh)) {
    log.info({ accountId: account.id }, 'Another writer already refreshed this token');
    return;
  }

  await db
    .updateTable('marketplace_accounts')
    .set({
      encrypted_credentials: encrypt(credentials),
      connection_status: 'CONNECTED',
      last_error: null,
      version: sql<string>`version + 1`,
      updated_at: new Date(),
    })
    .where('id', '=', account.id)
    .execute();
}

async function markTokenExpired(account: MarketplaceAccountRow): Promise<void> {
  await db
    .updateTable('marketplace_accounts')
    .set({
      connection_status: 'TOKEN_EXPIRED',
      last_error: 'eBay token refresh failed — reconnect the account',
      updated_at: new Date(),
    })
    .where('id', '=', account.id)
    .execute();
}

export { EBAY_SCOPES };
