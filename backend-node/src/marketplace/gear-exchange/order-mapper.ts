import type { ShippingAddressJson } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import type { ImportedOrder } from '../types.js';
import type { GxOrderDto } from './types.js';

const log = loggerFor('gx-order-mapper');

/**
 * Gear Exchange order → ImportedOrder.
 *
 * Every GX order is exactly one listing, one unit — the marketplace has no
 * quantity. So there is always exactly one line item.
 *
 * Returns null when the order has no id; callers must drop those (the
 * external_order_id column is NOT NULL).
 */

/**
 * Statuses where no sale should be recorded.
 *
 * An order that is already cancelled or refunded the first time Gearline sees
 * it (a missed poll, a webhook arriving late) must not be imported: importing
 * deducts inventory and mirrors the order into Shopify, both for a sale that
 * did not happen.
 */
export const DEAD_ORDER_STATUSES = new Set(['canceled', 'cancelled', 'refund completed']);

export function isDeadOrder(dto: Pick<GxOrderDto, 'status'>): boolean {
  return DEAD_ORDER_STATUSES.has(String(dto.status ?? '').trim().toLowerCase());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Our product UUID, if the listing carried one.
 *
 * Only a real UUID is passed through. A listing created by hand on GX may carry
 * any string in productId, and handing a non-UUID to the products lookup would
 * throw a Postgres "invalid input syntax for type uuid" and fail the import.
 */
export function gearlineProductId(dto: Pick<GxOrderDto, 'productId'>): string | null {
  const raw = dto.productId?.trim();
  return raw && UUID.test(raw) ? raw : null;
}

function money(value: string | undefined): string {
  if (value && /^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim();
  if (value) log.warn({ value }, 'Could not parse Gear Exchange amount');
  return '0';
}

function date(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    log.warn({ value }, 'Could not parse Gear Exchange date');
    return null;
  }
  return parsed.toISOString();
}

function address(dto: GxOrderDto): ShippingAddressJson | null {
  const a = dto.shippingInfo?.ship_to_address;
  if (!a) return null;
  return {
    line1: a.addressLineOne || null,
    line2: a.addressLineTwo || null,
    city: a.city || null,
    state: a.state || null,
    postalCode: a.postalCode || null,
    country: a.country || null,
  };
}

/**
 * @param sku the SKU of the matched Gearline product, when the connector could
 *   resolve one. GX orders carry no SKU of their own, and the Shopify mirror
 *   push resolves variants BY SKU — without it the mirrored order would land in
 *   Shopify as an unlinked custom line item.
 */
export function toImportedOrder(
  dto: GxOrderDto,
  resolved: { productId: string | null; sku: string | null; title: string | null } = {
    productId: gearlineProductId(dto),
    sku: null,
    title: null,
  },
): ImportedOrder | null {
  if (dto.orderId === undefined || dto.orderId === null || String(dto.orderId).trim() === '') {
    log.warn('Gear Exchange order has no orderId — skipping');
    return null;
  }

  const soldPrice = money(dto.soldPrice ?? dto.listedPrice);

  const firstName = dto.buyerInfo?.buyer_first_name ?? '';
  const lastName = dto.buyerInfo?.buyer_last_name ?? '';

  return {
    externalOrderId: String(dto.orderId),
    // GX exposes no per-order seller URL in the API.
    marketplaceOrderUrl: null,
    lineItems: [
      {
        productId: resolved.productId,
        externalListingId: dto.listingId === undefined || dto.listingId === null ? null : String(dto.listingId),
        sku: resolved.sku,
        title: resolved.title,
        quantity: 1,
        // soldPrice, not listedPrice: an accepted offer or a GX sale event means
        // the buyer paid less than the listing said.
        unitPrice: soldPrice,
        lineTotal: soldPrice,
      },
    ],
    subtotal: soldPrice,
    shippingTotal: money(dto.shippingAmount),
    taxTotal: money(dto.taxAmount),
    totalAmount: money(dto.totalAmount),
    currency: 'USD',
    buyerInfo: {
      externalBuyerId:
        dto.buyerInfo?.buyer_id === undefined || dto.buyerInfo?.buyer_id === null
          ? null
          : String(dto.buyerInfo.buyer_id),
      username: [firstName, lastName].filter((s) => s !== '').join(' ') || null,
      // GX does not share the buyer's email with sellers.
      email: null,
      firstName,
      lastName,
      phone: null,
    },
    shippingAddress: address(dto),
    createdAt: date(dto.soldAt),
  };
}
