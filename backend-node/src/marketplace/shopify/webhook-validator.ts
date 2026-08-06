import { createHmac, timingSafeEqual } from 'node:crypto';

import { config } from '../../config.js';
import { loggerFor } from '../../logger.js';

const log = loggerFor('shopify-webhook-validator');

/**
 * Validates inbound Shopify requests. Port of ShopifyWebhookValidator.
 *
 * Two schemes:
 *
 *   1. Standard webhooks — header X-Shopify-Hmac-Sha256, a Base64 HMAC-SHA256
 *      of the RAW request body, keyed with SHOPIFY_CLIENT_SECRET.
 *
 *   2. Shopify Flows "Send HTTP Request" — a plain static token in a
 *      configurable header. Flows does NOT sign payloads, so this is a shared
 *      secret comparison, not an HMAC.
 *
 * Both use constant-time comparison.
 */

/**
 * Constant-time string comparison.
 *
 * timingSafeEqual throws when the buffers differ in length, which would itself
 * leak length through the exception path — so length is checked first and a
 * mismatch returns false immediately. Length is not secret here (both values
 * are fixed-size for a given algorithm), but the comparison of CONTENTS must
 * not short-circuit, and that is what timingSafeEqual guarantees.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies the HMAC of a standard Shopify webhook.
 *
 * ── The raw body requirement ─────────────────────────────────────────────────
 *
 * `payload` MUST be the exact bytes Shopify sent. Re-serialising the parsed
 * JSON produces different bytes — key order, whitespace, unicode escaping — and
 * every signature then fails. app.ts captures the raw buffer in the
 * express.json `verify` hook; handlers must pass req.rawBody, never
 * JSON.stringify(req.body).
 *
 * ── Dev-mode bypass ──────────────────────────────────────────────────────────
 *
 * When SHOPIFY_CLIENT_SECRET is unset this returns true, matching the Java
 * behaviour so local development works without credentials.
 *
 * That is a fail-OPEN path, which is worth being explicit about: if the secret
 * is ever missing in production, every webhook is accepted unverified and
 * anyone who knows the URL can inject product and inventory changes. The
 * warning below is the only signal. Verify the secret is set after any
 * environment change.
 */
export function isValidSignature(payload: Buffer, hmacHeader: string | undefined): boolean {
  const clientSecret = config.shopify.clientSecret;

  if (!clientSecret || clientSecret.trim() === '') {
    log.warn(
      'SHOPIFY_CLIENT_SECRET is not configured — webhook signature validation is being ' +
        'SKIPPED. Every webhook is accepted unverified. Do not run this way in production.',
    );
    return true;
  }

  if (!hmacHeader || hmacHeader.trim() === '') return false;

  try {
    const computed = createHmac('sha256', clientSecret).update(payload).digest('base64');
    return constantTimeEquals(computed, hmacHeader);
  } catch (err) {
    log.error({ err }, 'Error validating Shopify webhook signature');
    return false;
  }
}

/**
 * Validates a Shopify Flows static token.
 *
 * Same fail-open caveat as above when SHOPIFY_FLOW_SECRET is unset.
 */
export function isValidFlowToken(incomingToken: string | undefined): boolean {
  const flowSecret = config.shopify.flowSecret;

  if (!flowSecret || flowSecret.trim() === '') {
    log.warn('SHOPIFY_FLOW_SECRET is not configured — Flows token validation is being SKIPPED.');
    return true;
  }

  if (!incomingToken || incomingToken.trim() === '') return false;

  return constantTimeEquals(flowSecret, incomingToken);
}

/** Header carrying the Flows token. Configurable; defaults to X-Shopify-Flow-Token. */
export function flowTokenHeaderName(): string {
  const header = config.shopify.flowTokenHeader;
  return header && header.trim() !== '' ? header : 'X-Shopify-Flow-Token';
}
