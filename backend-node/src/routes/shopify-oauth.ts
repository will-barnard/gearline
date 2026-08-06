import { Router } from 'express';

import { loggerFor } from '../logger.js';
import {
  buildInstallUrl,
  completeCallback,
  consumeNonce,
  frontendRedirectUrl,
  isValidOAuthHmac,
  isValidShopDomain,
} from '../marketplace/shopify/oauth.js';
import { syncAllProducts } from '../marketplace/shopify/initial-sync.js';
import { asyncHandler } from '../http/errors.js';

const log = loggerFor('shopify-oauth-routes');

/**
 * Shopify OAuth install and callback.
 * Mounted at /api/v1/marketplace/shopify/oauth — UNAUTHENTICATED.
 *
 * These are browser redirects during the handshake, so no JWT is available.
 * Authenticity is established by the HMAC and the single-use nonce, matching
 * `.requestMatchers("/api/v1/marketplace/shopify/oauth/**").permitAll()`.
 */
export const shopifyOAuthRouter: Router = Router();

// ── Step 1: install ──────────────────────────────────────────────────────────

shopifyOAuthRouter.get(
  '/install',
  asyncHandler(async (req, res) => {
    const shop = typeof req.query.shop === 'string' ? req.query.shop : undefined;

    // Open-redirect guard — `shop` ends up in the URL we send the browser to.
    if (!isValidShopDomain(shop)) {
      res.status(400).json({
        title: 'Invalid shop domain',
        status: 400,
        detail: 'Must be a valid .myshopify.com domain (e.g. mystore.myshopify.com)',
      });
      return;
    }

    const authorizationUrl = buildInstallUrl(shop);
    log.info({ shop }, 'Initiating Shopify OAuth');

    res.redirect(authorizationUrl);
  }),
);

// ── Step 2: callback ─────────────────────────────────────────────────────────

shopifyOAuthRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const shop = typeof req.query.shop === 'string' ? req.query.shop : undefined;
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const hmac = typeof req.query.hmac === 'string' ? req.query.hmac : undefined;

    if (!shop || !code || !state || !hmac) {
      res.status(400).json({
        title: 'Malformed OAuth callback',
        status: 400,
        detail: 'Missing one of: shop, code, state, hmac',
      });
      return;
    }

    /**
     * Validate against the RAW query string.
     *
     * req.query is already parsed and decoded; Shopify computes the signature
     * over the encoded form, so the raw string is the only correct input.
     * `req.url` keeps it intact after the "?".
     */
    const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';

    if (!isValidOAuthHmac(rawQuery, hmac)) {
      log.warn({ shop }, 'Shopify OAuth HMAC mismatch — possible request forgery');
      res.status(401).json({
        title: 'Invalid HMAC signature',
        status: 401,
        detail: 'The callback signature did not validate',
      });
      return;
    }

    // Single-use, 10-minute nonce. Guards against replay and CSRF.
    if (!consumeNonce(state)) {
      log.warn({ shop, state }, 'Shopify OAuth callback with invalid or expired nonce');
      res.status(400).json({
        title: 'Invalid or expired OAuth state',
        status: 400,
        detail: 'Start the install again from the Marketplaces page',
      });
      return;
    }

    if (!isValidShopDomain(shop)) {
      res.status(400).json({ title: 'Invalid shop domain', status: 400 });
      return;
    }

    const result = await completeCallback(shop, code);

    if (!result.success || !result.account) {
      res.redirect(frontendRedirectUrl(false, result.error));
      return;
    }

    /**
     * Kick off the initial catalogue import.
     *
     * Detached deliberately — a large store takes minutes to page through, and
     * the merchant's browser is sitting on this redirect. The import is
     * idempotent, so a failure part-way can simply be re-run from the
     * Marketplaces page.
     */
    void syncAllProducts(result.account).catch((err: unknown) => {
      log.error({ err, shop }, 'Initial product sync failed after OAuth');
    });

    res.redirect(frontendRedirectUrl(true));
  }),
);
