import { createHash, randomUUID } from 'node:crypto';

import { Router } from 'express';

import { config } from '../config.js';
import { db, sql } from '../db/index.js';
import { asyncHandler } from '../http/errors.js';
import { loggerFor } from '../logger.js';
import { ebayAuthProvider } from '../marketplace/ebay/auth-provider.js';
import { encrypt } from '../security/credential-encryptor.js';
import * as audit from '../services/audit.js';

const log = loggerFor('ebay-routes');

/** Path appended to APP_BASE_URL to form the registered notification endpoint. */
const NOTIFICATION_PATH = '/api/v1/marketplace/ebay/notifications';

// ─────────────────────────────────────────────────────────────────────────────
// eBay OAuth — /api/v1/marketplace/ebay/oauth
// ─────────────────────────────────────────────────────────────────────────────

export const ebayOAuthRouter: Router = Router();

/** Single-use nonces. Same in-memory caveat as the Shopify flow. */
const pendingNonces = new Map<string, number>();
const NONCE_EXPIRY_MS = 600_000;

function evictExpiredNonces(): void {
  const now = Date.now();
  for (const [nonce, expiry] of pendingNonces) {
    if (now > expiry) pendingNonces.delete(nonce);
  }
}

ebayOAuthRouter.get(
  '/install',
  asyncHandler(async (_req, res) => {
    /**
     * eBay's redirect_uri is the RuName, NOT a URL — see auth-provider.ts.
     * Without it configured the authorize call fails with an opaque
     * invalid_request, so it is checked up front.
     */
    if (!config.ebay.ruName || config.ebay.ruName.trim() === '') {
      res.status(500).json({
        title: 'eBay is not configured',
        status: 500,
        detail:
          'EBAY_RU_NAME is not set. Find the RuName in the eBay Developer Portal under ' +
          'My Account → User Tokens → your keyset → View / Edit → RuName.',
      });
      return;
    }

    const nonce = randomUUID().replace(/-/g, '');
    pendingNonces.set(nonce, Date.now() + NONCE_EXPIRY_MS);
    evictExpiredNonces();

    res.redirect(ebayAuthProvider.buildAuthorizationUrl(nonce, config.ebay.ruName));
  }),
);

ebayOAuthRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;

    const frontendBase = (config.app.baseUrl || 'http://localhost:5173').replace(/\/+$/, '');
    const redirect = (ok: boolean, error?: string): void => {
      const params = new URLSearchParams({ ebay_connected: ok ? 'true' : 'false' });
      if (error) params.set('error', error);
      res.redirect(`${frontendBase}/marketplaces?${params.toString()}`);
    };

    if (!code || !state) {
      redirect(false, 'Missing code or state');
      return;
    }

    // Single-use nonce — guards against replay and CSRF.
    const expiry = pendingNonces.get(state);
    pendingNonces.delete(state);

    if (expiry === undefined || Date.now() > expiry) {
      log.warn({ state }, 'eBay OAuth callback with invalid or expired nonce');
      redirect(false, 'Invalid or expired OAuth state');
      return;
    }

    try {
      // The RuName again, not a URL.
      const credentials = await ebayAuthProvider.exchangeCodeForTokens(code, config.ebay.ruName);

      /**
       * eBay gives no shop domain to key on, so a stable synthetic identifier
       * is used instead. Without it, every reconnect would create a duplicate
       * account row.
       */
      const externalAccountId = 'ebay-seller';
      const encrypted = encrypt(credentials);

      const existing = await db
        .selectFrom('marketplace_accounts')
        .selectAll()
        .where('marketplace_type', '=', 'EBAY')
        .where('external_account_id', '=', externalAccountId)
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable('marketplace_accounts')
          .set({
            encrypted_credentials: encrypted,
            connection_status: 'CONNECTED',
            active: true,
            last_error: null,
            version: sql<string>`version + 1`,
            updated_at: new Date(),
          })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await db
          .insertInto('marketplace_accounts')
          .values({
            marketplace_type: 'EBAY',
            display_name: 'eBay',
            external_account_id: externalAccountId,
            connection_status: 'CONNECTED',
            active: true,
            encrypted_credentials: encrypted,
            sync_settings: sql`'{}'::jsonb`,
          })
          .onConflict((oc) => oc.column('external_account_id').doNothing())
          .execute();
      }

      audit.recordMarketplaceEvent(
        'MARKETPLACE_CONNECTED',
        'EBAY',
        null,
        'MarketplaceAccount',
        externalAccountId,
        true,
        null,
        {},
      );

      log.info('eBay account connected');
      redirect(true);
    } catch (err) {
      log.error({ err }, 'eBay token exchange failed');
      redirect(false, 'Token exchange failed');
    }
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// eBay account-deletion notifications — /api/v1/marketplace/ebay/notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GDPR / CCPA account-deletion notifications. Port of EbayNotificationsController.
 *
 * eBay requires every developer app to expose a verified endpoint for these.
 * **Until it verifies, the developer keyset stays disabled** — so getting the
 * challenge hash wrong does not merely break this endpoint, it stops all eBay
 * API access.
 *
 * Docs: https://developer.ebay.com/develop/guides-v2/marketplace-user-account-deletion
 */
export const ebayNotificationsRouter: Router = Router();

/**
 * Computes the challenge response.
 *
 * SHA-256 over the concatenation, in this exact order, with NO delimiter:
 *
 *     challengeCode || verificationToken || endpointUrl
 *
 * Matching eBay's official sample, which does two incremental digest updates
 * and passes the endpoint to digest(). Concatenating the buffers is equivalent.
 *
 * The endpointUrl must match what was typed into the Developer Portal
 * CHARACTER FOR CHARACTER — a trailing slash or http-vs-https difference
 * changes the hash and fails verification with no useful diagnostic. That is
 * what the /debug route below exists to check.
 */
function computeChallengeResponse(
  challengeCode: string,
  verificationToken: string,
  endpointUrl: string,
): string {
  return createHash('sha256')
    .update(Buffer.from(challengeCode, 'utf8'))
    .update(Buffer.from(verificationToken, 'utf8'))
    .update(Buffer.from(endpointUrl, 'utf8'))
    .digest('hex');
}

function computeEndpointUrl(): string {
  const base = (config.app.baseUrl ?? '').replace(/\/+$/, '');
  return `${base}${NOTIFICATION_PATH}`;
}

/** GET — the one-time ownership challenge. */
ebayNotificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const challengeCode =
      typeof req.query.challenge_code === 'string' ? req.query.challenge_code : undefined;

    if (!challengeCode) {
      res.status(400).json({
        title: 'Missing challenge_code',
        status: 400,
        detail: 'eBay sends challenge_code as a query parameter',
      });
      return;
    }

    const verificationToken = config.ebay.notificationVerificationToken;

    if (!verificationToken || verificationToken.trim() === '') {
      log.error(
        'EBAY_NOTIFICATION_VERIFICATION_TOKEN is not configured — set it to the same ' +
          'value entered in the Developer Portal',
      );
      res.status(500).json({
        title: 'Not configured',
        status: 500,
        detail: 'EBAY_NOTIFICATION_VERIFICATION_TOKEN is not configured',
      });
      return;
    }

    const endpointUrl = computeEndpointUrl();
    const challengeResponse = computeChallengeResponse(
      challengeCode,
      verificationToken,
      endpointUrl,
    );

    log.info({ endpointUrl, challengeCode, challengeResponse }, 'eBay challenge verification');

    res.json({ challengeResponse });
  }),
);

/**
 * POST — an actual account-deletion event.
 *
 * Gearline stores marketplace buyer data only as denormalised JSON on imported
 * orders (name, email, shipping address). There is no eBay user account to
 * delete, so this acknowledges and records the event for the audit trail.
 *
 * A 200 is required regardless: eBay retries non-2xx responses and repeated
 * failures can get the endpoint marked unhealthy and the keyset disabled.
 */
ebayNotificationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const notification = body['notification'];

    const data =
      typeof notification === 'object' && notification !== null
        ? ((notification as Record<string, unknown>)['data'] as Record<string, unknown> | undefined)
        : undefined;

    const username = data?.['username'];
    const userId = data?.['userId'];

    log.info({ username, userId }, 'eBay account deletion notification received');

    audit.recordMarketplaceEvent(
      'WEBHOOK_RECEIVED',
      'EBAY',
      null,
      'AccountDeletion',
      String(userId ?? username ?? 'unknown'),
      true,
      null,
      { username: String(username ?? ''), userId: String(userId ?? '') },
    );

    res.status(200).end();
  }),
);

/**
 * Debug helper — no auth, and deliberately so.
 *
 * Verification failures are almost always an endpoint URL mismatch, and the
 * portal gives no diagnostic. This shows exactly what the backend hashes so it
 * can be compared against what was typed in. The token itself is NOT returned,
 * only whether it is set.
 */
ebayNotificationsRouter.get(
  '/debug',
  asyncHandler(async (_req, res) => {
    const token = config.ebay.notificationVerificationToken;

    res.json({
      endpointUrl: computeEndpointUrl(),
      appBaseUrl: config.app.baseUrl,
      verificationTokenConfigured: Boolean(token && token.trim() !== ''),
      verificationTokenLength: token?.length ?? 0,
      hint:
        'endpointUrl must match the Developer Portal value character for character — ' +
        'check for a trailing slash or http vs https.',
    });
  }),
);
