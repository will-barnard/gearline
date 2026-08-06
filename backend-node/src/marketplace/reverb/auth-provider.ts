import { config } from '../../config.js';
import { db, sql } from '../../db/index.js';
import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { encrypt, readCredentials } from '../../security/credential-encryptor.js';
import { apiRequest } from '../http.js';
import type { MarketplaceAuthProvider } from '../types.js';

const log = loggerFor('reverb-auth');

/**
 * Reverb OAuth 2.0 token lifecycle. Port of ReverbAuthProvider.
 *
 * https://reverb.com/page/api#authentication
 */

/** Treat a token as expired 5 minutes early, so it cannot lapse mid-request. */
const EXPIRY_SKEW_MS = 300_000;

/**
 * Per-account refresh mutex.
 *
 * Two concurrent requests for the same account would both see an expired token
 * and both hit Reverb's token endpoint. Reverb invalidates the previous refresh
 * token on use, so the second call invalidates the first — leaving whichever
 * result was written last, and sometimes neither working.
 *
 * Java used a ConcurrentHashMap of lock objects with synchronized blocks. Node
 * is single-threaded, so the equivalent is to memoise the in-flight PROMISE:
 * concurrent callers await the same refresh rather than starting a second one.
 * That is simpler and strictly stronger than the Java version, because there is
 * no window between the check and the lock acquisition.
 *
 * Cross-process races (two containers) are still possible; the optimistic-lock
 * retry in persistCredentials handles those.
 */
const inFlightRefreshes = new Map<string, Promise<void>>();

function authUrl(path: string): string {
  return `${config.reverb.authUrl}${path}`;
}

export const reverbAuthProvider: MarketplaceAuthProvider = {
  buildAuthorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: config.reverb.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'read_listings write_listings read_orders',
      state,
    });

    // URLSearchParams encodes spaces as '+', which is what Reverb's scope
    // parameter expects — matching the literal '+' separators in the Java version.
    return `${authUrl('/authorize')}?${params.toString()}`;
  },

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<Record<string, string>> {
    const response = await apiRequest<{
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number | string;
    }>({
      marketplace: 'Reverb',
      method: 'POST',
      url: authUrl('/token'),
      form: {
        client_id: config.reverb.clientId,
        client_secret: config.reverb.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      },
    });

    const body = response.body;

    if (!body?.access_token) {
      throw new Error('Empty or invalid token response from Reverb');
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
      log.debug({ accountId: account.id }, 'Joining in-flight Reverb token refresh');
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

/** Synchronous validity check — no I/O, just the stored expiry. */
function credentialsValid(account: MarketplaceAccountRow): boolean {
  const credentials = readCredentials(account.encrypted_credentials);

  if (!credentials['access_token']) return false;

  const expiresAt = credentials['expires_at'];
  if (!expiresAt) return true; // No expiry recorded — assume valid, as Java did.

  const expiry = Number.parseInt(expiresAt, 10);
  if (!Number.isFinite(expiry)) return true;

  return Date.now() < expiry - EXPIRY_SKEW_MS;
}

function expiryTimestamp(expiresIn: number | string): number {
  const seconds = typeof expiresIn === 'number' ? expiresIn : Number.parseInt(expiresIn, 10);
  return Date.now() + (Number.isFinite(seconds) ? seconds : 0) * 1000;
}

async function doRefresh(account: MarketplaceAccountRow): Promise<void> {
  try {
    // Re-read from the database rather than trusting the passed-in row: another
    // process may have refreshed while this call was queued.
    const fresh = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('id', '=', account.id)
      .executeTakeFirst();

    if (!fresh) {
      log.error({ accountId: account.id }, 'Reverb account disappeared during refresh');
      return;
    }

    if (credentialsValid(fresh)) {
      log.debug({ accountId: account.id }, 'Reverb token already valid — refreshed elsewhere');
      return;
    }

    const credentials = readCredentials(fresh.encrypted_credentials);
    const refreshToken = credentials['refresh_token'];

    if (!refreshToken) {
      log.warn({ accountId: account.id }, 'No refresh token available for Reverb account');
      await markTokenExpired(fresh);
      return;
    }

    const response = await apiRequest<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number | string;
    }>({
      marketplace: 'Reverb',
      method: 'POST',
      url: authUrl('/token'),
      form: {
        client_id: config.reverb.clientId,
        client_secret: config.reverb.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    });

    const body = response.body;

    if (!body?.access_token) {
      /**
       * A 2xx response with no access_token means Reverb returned an error body.
       * The original code silently did nothing here, leaving the account
       * looking healthy while every subsequent call failed. Log the shape and
       * mark it expired so the operator sees it on the Marketplaces page.
       */
      log.error(
        { accountId: account.id, responseKeys: Object.keys(body ?? {}) },
        'Reverb token refresh returned a response with no access_token',
      );
      await markTokenExpired(fresh);
      return;
    }

    const updated: Record<string, string> = { ...credentials, access_token: body.access_token };

    // Reverb rotates refresh tokens. If a new one came back it MUST replace the
    // old one, or the next refresh will present an already-invalidated token.
    if (body.refresh_token) updated['refresh_token'] = body.refresh_token;
    if (body.expires_in !== undefined) {
      updated['expires_at'] = String(expiryTimestamp(body.expires_in));
    }

    await persistCredentials(fresh, updated);
    log.info({ accountId: account.id }, 'Refreshed Reverb token');
  } catch (err) {
    log.error({ err, accountId: account.id }, 'Failed to refresh Reverb token');

    const current = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('id', '=', account.id)
      .executeTakeFirst();

    if (current) await markTokenExpired(current);
  }
}

/**
 * Writes refreshed credentials, guarded by an optimistic-lock predicate.
 *
 * On conflict another writer moved the row first — almost certainly a second
 * container refreshing the same account. Re-read and retry once; if the row is
 * now valid, the other writer's token is good and there is nothing to do.
 */
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

  log.warn({ accountId: account.id }, 'Optimistic lock conflict saving Reverb credentials — retrying');

  const fresh = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('id', '=', account.id)
    .executeTakeFirst();

  if (!fresh) {
    log.error({ accountId: account.id }, 'Reverb account not found during optimistic-lock retry');
    return;
  }

  if (credentialsValid(fresh)) {
    log.info({ accountId: account.id }, 'Another writer already refreshed this token — nothing to do');
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

  log.info({ accountId: account.id }, 'Reverb credentials saved on retry');
}

async function markTokenExpired(account: MarketplaceAccountRow): Promise<void> {
  await db
    .updateTable('marketplace_accounts')
    .set({
      connection_status: 'TOKEN_EXPIRED',
      last_error: 'Reverb token refresh failed — reconnect the account',
      updated_at: new Date(),
    })
    .where('id', '=', account.id)
    .execute();
}
