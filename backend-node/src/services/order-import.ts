import { db } from '../db/index.js';
import { toJson } from '../db/json.js';
import type { MarketplaceAccountRow, OrderRow } from '../db/types.js';
import { loggerFor } from '../logger.js';
import type { ImportedOrder } from '../marketplace/types.js';
import { pushToShopify } from '../marketplace/shopify/order-push.js';
import { handleOrderImported } from './inventory-consistency.js';
import * as audit from './audit.js';

const log = loggerFor('order-import');

/**
 * Port of OrderImportService — the single entry point for importing an order
 * from any marketplace.
 *
 * Pipeline:
 *   0. Reject malformed input (null/blank external ID)
 *   1. Deduplicate on (marketplace_type, external_order_id)
 *   2. Persist
 *   3. Deduct inventory and propagate cross-channel
 *   4. Push a mirror order to Shopify
 *
 * ── Failure isolation ────────────────────────────────────────────────────────
 *
 * Steps 3 and 4 are wrapped individually and never propagate. Once the order
 * row exists, the import has succeeded — losing the record because a downstream
 * Shopify call failed would mean the sale silently disappears. A failed
 * deduction shows up as an inventory mismatch the operator can correct; a lost
 * order does not show up at all.
 */

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export async function importOrder(
  importedOrder: ImportedOrder,
  account: MarketplaceAccountRow,
): Promise<OrderRow | null> {
  // ── 0. Guard ──────────────────────────────────────────────────────────────
  // external_order_id is NOT NULL. A blank one means the connector mapped the
  // wrong field; reject it here with a diagnosable message rather than letting
  // the constraint fire deep in the insert.
  if (!importedOrder.externalOrderId || importedOrder.externalOrderId.trim() === '') {
    log.warn(
      { marketplace: account.marketplace_type },
      'Skipping order with null/blank externalOrderId — check connector DTO field mappings',
    );
    return null;
  }

  // ── 1. Deduplicate ────────────────────────────────────────────────────────
  const existing = await db
    .selectFrom('orders')
    .select('id')
    .where('marketplace_type', '=', account.marketplace_type)
    .where('external_order_id', '=', importedOrder.externalOrderId)
    .executeTakeFirst();

  if (existing) {
    log.debug(
      { externalOrderId: importedOrder.externalOrderId, marketplace: account.marketplace_type },
      'Order already imported — skipping',
    );
    return null;
  }

  // ── 2. Persist ────────────────────────────────────────────────────────────
  let order: OrderRow;

  try {
    order = await db
      .insertInto('orders')
      .values({
        external_order_id: importedOrder.externalOrderId,
        marketplace_account_id: account.id,
        marketplace_type: account.marketplace_type,
        order_status: 'IMPORTED',
        line_items: toJson(importedOrder.lineItems),
        subtotal: importedOrder.subtotal,
        shipping_total: importedOrder.shippingTotal,
        tax_total: importedOrder.taxTotal,
        total_amount: importedOrder.totalAmount,
        currency: importedOrder.currency ?? 'USD',
        buyer_info: toJson(importedOrder.buyerInfo),
        shipping_address: toJson(importedOrder.shippingAddress),
        marketplace_order_url: importedOrder.marketplaceOrderUrl,
        imported_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    /**
     * Two workers both passed the existence check before either inserted. The
     * unique constraint on (marketplace_type, external_order_id) correctly
     * rejected the second. That is a successful dedup, not an error — the
     * order exists, which is all we wanted.
     */
    if (isUniqueViolation(err)) {
      log.debug(
        { externalOrderId: importedOrder.externalOrderId },
        'Order already imported (concurrent insert race) — skipping',
      );
      return null;
    }
    throw err;
  }

  log.info(
    {
      marketplace: account.marketplace_type,
      externalOrderId: importedOrder.externalOrderId,
      orderId: order.id,
    },
    'Imported order',
  );

  audit.recordMarketplaceEvent(
    'ORDER_IMPORTED',
    account.marketplace_type,
    null,
    'Order',
    order.id,
    true,
    null,
    { externalOrderId: importedOrder.externalOrderId },
  );

  // ── 3. Inventory deduction ────────────────────────────────────────────────
  try {
    await handleOrderImported(importedOrder, account);
  } catch (err) {
    log.error(
      { err, externalOrderId: importedOrder.externalOrderId },
      'Inventory deduction failed — order still recorded',
    );
    audit.recordMarketplaceEvent(
      'INVENTORY_MISMATCH_DETECTED',
      account.marketplace_type,
      null,
      'Order',
      order.id,
      false,
      err instanceof Error ? err.message : String(err),
      {},
    );
  }

  // ── 4. Shopify mirror push ────────────────────────────────────────────────
  /**
   * Mirrors the order into Shopify and writes back orders.shopify_order_id.
   *
   * Shopify-sourced orders are skipped: pushing a Shopify order back into
   * Shopify would create a duplicate of itself.
   *
   * pushToShopify swallows its own failures, but it is wrapped anyway so that
   * an unexpected throw still cannot undo a recorded sale.
   */
  if (account.marketplace_type !== 'SHOPIFY') {
    try {
      await pushToShopify(order, importedOrder, account.marketplace_type);
    } catch (err) {
      log.error(
        { err, externalOrderId: importedOrder.externalOrderId },
        'Shopify push failed — order still recorded',
      );
    }
  }

  return order;
}
