import { db } from '../../db/index.js';
import type { MarketplaceType, OrderLineItemJson } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { compareDecimal, parseDecimal, ZERO } from '../../util/decimal.js';
import type { ImportedOrder } from '../types.js';

const log = loggerFor('shopify-order-mapper');

/**
 * Builds a Shopify Admin API order-creation body from an ImportedOrder.
 * Port of ShopifyOrderMapper.
 *
 * ── The flags that matter ────────────────────────────────────────────────────
 *
 * inventory_behaviour: "bypass"
 *     CRITICAL. Without it Shopify deducts stock when this order is created,
 *     double-counting against the deduction InventoryConsistencyService has
 *     already applied. The item would go to zero after a single sale of one.
 *
 * financial_status: "paid"
 *     The buyer already paid on Reverb/eBay. Anything else leaves a phantom
 *     unpaid balance in the merchant's Shopify accounting.
 *
 * send_receipt / send_fulfillment_receipt: false
 *     The marketplace already emailed the buyer. Leaving these on sends a
 *     second, confusing confirmation from a store they did not buy from.
 *
 * name: "#{externalOrderId}"
 *     Shows the marketplace order number instead of Shopify's auto-increment,
 *     so the two systems can be reconciled by eye. Reverb IDs are in the
 *     millions and eBay IDs are long numerics, so neither collides with a
 *     store's own order numbering.
 */

/** Display name for the source channel. Shopify shows this in its UI. */
function displayName(sourceType: MarketplaceType): string {
  if (sourceType === 'EBAY') return 'eBay'; // not "Ebay"
  return sourceType.charAt(0) + sourceType.slice(1).toLowerCase();
}

/**
 * Resolves Shopify variant IDs for a batch of SKUs in ONE query.
 *
 * The Java version looked each SKU up individually inside the line-item loop.
 * Orders are small so it was survivable, but batching keeps this off the
 * per-item path entirely.
 *
 * A missing variant ID is fine — the line item is then created as a custom
 * item with title and SKU, which Shopify accepts.
 */
async function resolveVariantIds(skus: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(skus.filter((s): s is string => Boolean(s)))];
  if (unique.length === 0) return new Map();

  const rows = await db
    .selectFrom('products')
    .select(['sku', 'shopify_variant_id'])
    .where('sku', 'in', unique)
    .execute();

  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.shopify_variant_id) map.set(row.sku, row.shopify_variant_id);
  }
  return map;
}

function buildLineItems(
  lineItems: OrderLineItemJson[],
  variantIds: Map<string, string>,
  source: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const item of lineItems) {
    const li: Record<string, unknown> = {};

    const variantId = item.sku ? variantIds.get(item.sku) : undefined;

    if (variantId) {
      const numeric = Number(variantId);
      if (Number.isSafeInteger(numeric)) {
        li['variant_id'] = numeric;
      } else {
        log.warn(
          { variantId, sku: item.sku },
          'Non-numeric Shopify variant ID — falling back to title/SKU line item',
        );
      }
    }

    // Title and SKU are always sent; Shopify displays them even when a
    // variant_id links the line to the catalogue.
    if (item.title) li['title'] = item.title;
    if (item.sku) li['sku'] = item.sku;

    li['quantity'] = item.quantity ?? 1;
    if (item.unitPrice) li['price'] = item.unitPrice;
    li['requires_shipping'] = true;

    result.push(li);
  }

  /**
   * No $0 placeholder when the list is empty.
   *
   * A placeholder line would create a fake item with no SKU, no variant link
   * and zero revenue, corrupting Shopify analytics and inventory. The caller
   * skips the push entirely instead — see push-service.ts.
   */
  if (result.length === 0) {
    log.warn({ source }, 'Order has no mappable line items — caller will skip the Shopify push');
  }

  return result;
}

export async function toShopifyOrderBody(
  importedOrder: ImportedOrder,
  sourceType: MarketplaceType,
): Promise<Record<string, unknown>> {
  const source = sourceType.toLowerCase(); // "reverb" | "ebay"
  const sourceName = displayName(sourceType);

  const variantIds = await resolveVariantIds(
    importedOrder.lineItems.map((li) => li.sku).filter((s): s is string => Boolean(s)),
  );

  const order: Record<string, unknown> = {
    line_items: buildLineItems(importedOrder.lineItems, variantIds, source),
    financial_status: 'paid',
    currency: importedOrder.currency ?? 'USD',
  };

  // ── Shipping ───────────────────────────────────────────────────────────────

  // Only send a shipping line when there is an actual charge. Comparing via the
  // decimal helpers rather than parseFloat keeps "0.00" and "0" both reading as
  // zero without a float round-trip.
  if (importedOrder.shippingTotal) {
    const shipping = parseDecimal(importedOrder.shippingTotal);
    if (compareDecimal(shipping, ZERO) > 0) {
      order['shipping_lines'] = [
        {
          title: `Shipping (${source})`,
          price: importedOrder.shippingTotal,
          code: `${source}_shipping`,
        },
      ];
    }
  }

  // ── Customer ───────────────────────────────────────────────────────────────

  const buyer = importedOrder.buyerInfo;

  if (buyer) {
    const customer: Record<string, unknown> = {};
    if (buyer.firstName) customer['first_name'] = buyer.firstName;
    if (buyer.lastName) customer['last_name'] = buyer.lastName;
    if (buyer.email) customer['email'] = buyer.email;
    if (Object.keys(customer).length > 0) order['customer'] = customer;
  }

  // ── Shipping address ───────────────────────────────────────────────────────

  const addr = importedOrder.shippingAddress;

  if (addr) {
    const shipAddr: Record<string, unknown> = {};

    if (buyer) {
      shipAddr['first_name'] = buyer.firstName ?? '';
      shipAddr['last_name'] = buyer.lastName ?? '';
    }

    // Shopify's field names differ from ours: address1/address2/province/zip.
    if (addr.line1) shipAddr['address1'] = addr.line1;
    if (addr.line2) shipAddr['address2'] = addr.line2;
    if (addr.city) shipAddr['city'] = addr.city;
    if (addr.state) shipAddr['province'] = addr.state;
    if (addr.postalCode) shipAddr['zip'] = addr.postalCode;
    if (addr.country) shipAddr['country'] = addr.country;

    if (Object.keys(shipAddr).length > 0) order['shipping_address'] = shipAddr;
  }

  // ── Identity and channel metadata ──────────────────────────────────────────

  order['name'] = `#${importedOrder.externalOrderId}`;
  order['source_name'] = source;
  order['source_identifier'] = importedOrder.externalOrderId;

  if (importedOrder.marketplaceOrderUrl) {
    // Makes the order ID a clickable link back to the marketplace in Shopify.
    order['source_url'] = importedOrder.marketplaceOrderUrl;
  }

  order['tags'] = source;
  order['note'] = `Imported from ${sourceName} order #${importedOrder.externalOrderId}`;

  // "Additional details" panel on the Shopify order page.
  const noteAttributes: Array<{ name: string; value: string }> = [
    { name: 'Channel', value: sourceName },
    { name: 'Order Number', value: importedOrder.externalOrderId },
  ];

  if (buyer?.username && buyer.username.trim() !== '') {
    noteAttributes.push({ name: 'Buyer Username', value: buyer.username });
  }

  if (importedOrder.marketplaceOrderUrl) {
    noteAttributes.push({
      name: `${sourceName} Order URL`,
      value: importedOrder.marketplaceOrderUrl,
    });
  }

  order['note_attributes'] = noteAttributes;

  // ── Behaviour flags ────────────────────────────────────────────────────────

  order['inventory_behaviour'] = 'bypass';
  order['send_receipt'] = false;
  order['send_fulfillment_receipt'] = false;

  return { order };
}
