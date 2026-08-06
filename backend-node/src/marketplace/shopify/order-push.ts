import { db } from '../../db/index.js';
import type { MarketplaceType, OrderRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import type { ImportedOrder } from '../types.js';
import * as client from './client.js';
import { toShopifyOrderBody } from './order-mapper.js';

const log = loggerFor('shopify-order-push');

/**
 * Mirrors a Reverb or eBay order into Shopify. Port of ShopifyOrderPushService.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 *
 * Shopify is the merchant's system of record for fulfilment and accounting.
 * Mirroring marketplace sales there means packing slips, unified revenue,
 * Shopify Flows and customer profiles all work across channels.
 *
 * It also underpins the fulfilment path: when a Shopify fulfillments/create
 * webhook fires, orders.shopify_order_id is how we find the source Reverb/eBay
 * order to notify. An order that never got pushed can never have its tracking
 * relayed back to the marketplace.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *
 * orders.shopify_order_id is the marker. If set, the push is skipped. Safe to
 * call repeatedly, which matters because order import retries.
 *
 * ── Graceful degradation ─────────────────────────────────────────────────────
 *
 * Every failure path logs and returns rather than throwing. The Gearline order
 * is already persisted by this point; failing here must not undo that or block
 * the import. A missed mirror is a visible gap the operator can fix. A lost
 * order is not.
 */
export async function pushToShopify(
  order: OrderRow,
  importedOrder: ImportedOrder,
  sourceType: MarketplaceType,
): Promise<void> {
  // ── 1. Already pushed? ─────────────────────────────────────────────────────
  if (order.shopify_order_id) {
    log.debug(
      { orderId: order.id, shopifyOrderId: order.shopify_order_id },
      'Order already pushed to Shopify — skipping',
    );
    return;
  }

  // ── 2. Is a Shopify account connected? ─────────────────────────────────────
  const shopifyAccount = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('marketplace_type', '=', 'SHOPIFY')
    .where('active', '=', true)
    .orderBy('created_at', 'asc')
    .executeTakeFirst();

  if (!shopifyAccount) {
    log.info({ orderId: order.id }, 'No active Shopify account connected — skipping order push');
    return;
  }

  // ── 3. Any line items to push? ─────────────────────────────────────────────
  // Shopify rejects an order with an empty line_items array, and the mapper
  // deliberately no longer fabricates a $0 placeholder. Skip instead.
  if (importedOrder.lineItems.length === 0) {
    log.warn(
      { sourceType, externalOrderId: importedOrder.externalOrderId },
      'Skipping Shopify push — order has no line items',
    );
    return;
  }

  // ── 4. Build and send ──────────────────────────────────────────────────────
  try {
    const body = await toShopifyOrderBody(importedOrder, sourceType);
    const response = await client.createOrder(shopifyAccount, body);

    const shopifyOrderId = extractOrderId(response);

    if (!shopifyOrderId) {
      log.warn(
        { orderId: order.id },
        'Shopify order created but the ID could not be parsed from the response',
      );
      return;
    }

    await db
      .updateTable('orders')
      .set({ shopify_order_id: shopifyOrderId, updated_at: new Date() })
      .where('id', '=', order.id)
      // Guard against a concurrent push having already written an ID. Without
      // it a duplicate push would overwrite the first Shopify order's ID and
      // orphan that order — invisible in Gearline, real in Shopify.
      .where('shopify_order_id', 'is', null)
      .execute();

    log.info(
      { sourceType, externalOrderId: importedOrder.externalOrderId, shopifyOrderId },
      'Pushed order to Shopify',
    );
  } catch (err) {
    // Non-fatal by design — see the class note above.
    log.error(
      { err, sourceType, externalOrderId: importedOrder.externalOrderId },
      'Failed to push order to Shopify — the Gearline order is still recorded',
    );
  }
}

/** Shopify returns { order: { id: 1234567890, ... } }. */
function extractOrderId(response: Record<string, unknown> | null): string | null {
  if (!response) return null;

  const orderNode = response['order'];
  if (typeof orderNode !== 'object' || orderNode === null) return null;

  const id = (orderNode as Record<string, unknown>)['id'];
  return id === null || id === undefined ? null : String(id);
}
