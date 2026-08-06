import { Router, type Request, type Response } from 'express';

import { loggerFor } from '../logger.js';
import * as processor from '../marketplace/shopify/webhook-processor.js';
import {
  flowTokenHeaderName,
  isValidFlowToken,
  isValidSignature,
} from '../marketplace/shopify/webhook-validator.js';
import * as audit from '../services/audit.js';

const log = loggerFor('shopify-webhooks');

/**
 * Shopify webhook receivers. Port of ShopifyWebhookController.
 *
 * Mounted at /webhooks/shopify, OUTSIDE the authentication chain — Shopify
 * cannot present a JWT. Authenticity comes from the HMAC instead.
 *
 * ── The 200-immediately contract ─────────────────────────────────────────────
 *
 * Shopify treats any non-2xx, or any response slower than 5 seconds, as a
 * failure and retries with backoff for up to 48 hours. Since processing
 * involves database writes and metafield API calls, doing it inline would blow
 * that budget and produce duplicate deliveries.
 *
 * So: validate, acknowledge, then process detached. A processing failure is
 * logged, never surfaced to Shopify — retrying would not help, because the
 * payload is not the problem.
 */
export const webhooksRouter: Router = Router();

/** Express's raw-body capture from app.ts. */
function rawBodyOf(req: Request): Buffer | null {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  return Buffer.isBuffer(raw) ? raw : null;
}

const SHOPIFY_TOPICS = [
  'inventory-levels/update',
  'products/update',
  'products/create',
  'orders/create',
  'fulfillments/create',
] as const;

/** URL path segment → Shopify topic string. Differ only for inventory levels. */
function topicFromPath(path: string): string {
  return path === 'inventory-levels/update' ? 'inventory_levels/update' : path;
}

for (const path of SHOPIFY_TOPICS) {
  webhooksRouter.post(`/shopify/${path}`, (req, res) => {
    const hmacHeader = req.header('x-shopify-hmac-sha256');
    const shopDomain = req.header('x-shopify-shop-domain') ?? 'unknown';
    // Trust Shopify's own topic header when present; fall back to the route.
    const topic = req.header('x-shopify-topic') ?? topicFromPath(path);

    const rawBody = rawBodyOf(req);

    if (!rawBody) {
      /**
       * No raw body means the express.json verify hook in app.ts did not run —
       * a misconfiguration, not a bad request. Fail CLOSED: accepting an
       * unverifiable payload would let anyone who knows the URL push product
       * and inventory changes.
       */
      log.error({ topic, shopDomain }, 'Raw body unavailable — cannot verify HMAC, rejecting');
      res.status(400).end();
      return;
    }

    // ── 1. Verify ──────────────────────────────────────────────────────────
    if (!isValidSignature(rawBody, hmacHeader)) {
      log.warn({ shopDomain, topic }, 'Invalid Shopify webhook signature');

      audit.recordMarketplaceEvent(
        'WEBHOOK_SIGNATURE_INVALID',
        'SHOPIFY',
        null,
        'Webhook',
        topic,
        false,
        'Invalid HMAC signature',
        { shop: shopDomain, topic },
      );

      res.status(401).end();
      return;
    }

    // ── 2. Audit receipt ───────────────────────────────────────────────────
    audit.recordMarketplaceEvent('WEBHOOK_RECEIVED', 'SHOPIFY', null, 'Webhook', topic, true, null, {
      shop: shopDomain,
      topic,
    });

    // ── 3. Acknowledge, then process detached ──────────────────────────────
    res.status(200).end();

    /**
     * Deliberately not awaited — the response has already been sent.
     *
     * processor.process never throws (it catches internally), but .catch is
     * kept as a backstop: an unhandled rejection here would terminate the
     * process via the handler in index.ts, taking down the whole service
     * because of one malformed webhook.
     */
    void processor.process(topic, shopDomain, rawBody).catch((err: unknown) => {
      log.error({ err, topic, shopDomain }, 'Unhandled error in webhook processing');
    });
  });
}

/**
 * Shopify Flows "Send HTTP Request" receiver.
 * Port of ShopifyFlowWebhookController.
 *
 * Flows does NOT sign its payloads. Authentication is a static shared token in
 * a configurable header, which is weaker than the HMAC path by design — treat
 * SHOPIFY_FLOW_SECRET with the same care as any other credential.
 *
 * The body is freely templated by the merchant, so only well-known keys are
 * read: `topic`, `shop_domain`, `shopify_product_id`. Anything else is
 * accepted and audit-logged, which lets Flows be used for notification-only
 * payloads without producing errors.
 */
function handleFlowEvent(req: Request, res: Response): void {
  const headerName = flowTokenHeaderName().toLowerCase();
  const token = req.header(headerName);

  if (!isValidFlowToken(token)) {
    log.warn({ headerName }, 'Invalid Shopify Flow token');

    audit.recordMarketplaceEvent(
      'WEBHOOK_SIGNATURE_INVALID',
      'SHOPIFY',
      null,
      'FlowWebhook',
      'flows',
      false,
      `Invalid Flow token on header: ${headerName}`,
      {},
    );

    res.status(401).end();
    return;
  }

  const payload = (req.body ?? {}) as Record<string, unknown>;

  const topic = typeof payload['topic'] === 'string' ? payload['topic'] : 'unknown';
  const shopDomain =
    typeof payload['shop_domain'] === 'string' ? payload['shop_domain'] : 'unknown';

  log.info({ topic, shopDomain }, 'Shopify Flow event received');

  audit.recordMarketplaceEvent('WEBHOOK_RECEIVED', 'SHOPIFY', null, 'FlowWebhook', topic, true, null, {
    shop: shopDomain,
    topic,
    source: 'flows',
  });

  const shopifyProductId =
    payload['shopify_product_id'] === null || payload['shopify_product_id'] === undefined
      ? ''
      : String(payload['shopify_product_id']);

  if (shopifyProductId.trim() === '') {
    log.debug('Shopify Flow event has no shopify_product_id — audit-logged only');
    res.status(200).end();
    return;
  }

  /**
   * ── DELIBERATE DEVIATION FROM THE JAVA BEHAVIOUR ───────────────────────────
   *
   * The Java version built a synthetic products/create payload with hardcoded
   * defaults for any field the Flow did not template:
   *
   *     variant.put("price", flowPayload.path("price").asText("0.00"));
   *     variant.put("inventory_quantity", ... .asInt(0));
   *     variant.put("sku", ... .asText(""));
   *
   * Those defaults are then fed into the product upsert, which writes any
   * non-blank value. "0.00" is not blank — so a Flow that omits `price`
   * (the common case, since most Flows only send an ID) would **overwrite the
   * product's real price with $0.00**, and quantity with 0. That price then
   * propagates to every ACTIVE listing via the LISTING_UPDATE jobs the
   * processor enqueues.
   *
   * Reproducing that faithfully would mean shipping a known data-destroying
   * bug, so instead we forward ONLY the fields the Flow actually supplied.
   * Omitted fields are omitted, and the upsert leaves the existing values
   * untouched.
   *
   * If you ever need the old behaviour, it was wrong — send the fields
   * explicitly from the Flow instead.
   */
  const synthetic: Record<string, unknown> = { id: shopifyProductId };

  for (const key of ['title', 'body_html', 'vendor', 'product_type', 'tags', 'status'] as const) {
    if (typeof payload[key] === 'string') synthetic[key] = payload[key];
  }

  const variant: Record<string, unknown> = {};

  if (payload['shopify_variant_id'] !== undefined) variant['id'] = String(payload['shopify_variant_id']);
  if (payload['sku'] !== undefined) variant['sku'] = String(payload['sku']);
  if (payload['price'] !== undefined) variant['price'] = String(payload['price']);
  if (payload['inventory_item_id'] !== undefined) {
    variant['inventory_item_id'] = String(payload['inventory_item_id']);
  }
  if (payload['inventory_quantity'] !== undefined) {
    variant['inventory_quantity'] = payload['inventory_quantity'];
  }

  // Only attach a variants array when the Flow actually sent variant data —
  // an empty variant would still be walked by the field extractor.
  if (Object.keys(variant).length > 0) synthetic['variants'] = [variant];

  res.status(200).end();

  void processor
    .process('products/create', shopDomain, Buffer.from(JSON.stringify(synthetic), 'utf8'))
    .catch((err: unknown) => {
      log.error({ err, topic, shopifyProductId }, 'Unhandled error processing Flow event');
    });
}

// Shopify Flows can be configured to post to the bare path or a named action.
webhooksRouter.post('/shopify/flows', handleFlowEvent);
webhooksRouter.post('/shopify/flows/:action', handleFlowEvent);
