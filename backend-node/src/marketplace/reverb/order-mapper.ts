import type { BuyerInfoJson, OrderLineItemJson, ShippingAddressJson } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import type { ImportedOrder } from '../types.js';
import type { ReverbOrderDto, ReverbPrice, ReverbShippingAddressDto } from './types.js';

const log = loggerFor('reverb-order-mapper');

/**
 * Port of ReverbOrderMapper.
 *
 * Returns null when the order has no identifiable ID. Callers MUST filter
 * those out — passing one to importOrder would hit the external_order_id
 * NOT NULL constraint.
 */
export function toImportedOrder(dto: ReverbOrderDto): ImportedOrder | null {
  const orderUrl = dto._links?.web?.href ?? null;
  const orderId = resolveOrderId(dto, orderUrl);

  if (!orderId) {
    log.warn('Reverb order has no identifiable ID (order_id null, no URL) — skipping');
    return null;
  }

  return {
    externalOrderId: orderId,
    marketplaceOrderUrl: orderUrl,
    lineItems: mapLineItems(dto, orderId),
    subtotal: parseMoney(dto.amount_product),
    shippingTotal: parseMoney(dto.amount_shipping),
    taxTotal: parseMoney(dto.amount_tax),
    totalAmount: parseMoney(dto.amount_total),
    currency: 'USD',
    buyerInfo: mapBuyerInfo(dto),
    shippingAddress: mapShippingAddress(dto.shipping_address),
    createdAt: parseDate(dto.created_at),
  };
}

/**
 * Resolves the order ID.
 *
 * Primary source is the `order_id` field. Reverb returns it as an integer, so
 * it is coerced to a string.
 *
 * Fallback: the last path segment of the web URL, which Reverb always includes
 * even when order_id is absent:
 *   https://reverb.com/my/selling/orders/25262223
 */
function resolveOrderId(dto: ReverbOrderDto, orderUrl: string | null): string | null {
  if (dto.order_id !== undefined && dto.order_id !== null && String(dto.order_id).trim() !== '') {
    return String(dto.order_id);
  }

  if (orderUrl) {
    const lastSlash = orderUrl.lastIndexOf('/');
    if (lastSlash >= 0 && lastSlash < orderUrl.length - 1) {
      const extracted = orderUrl.slice(lastSlash + 1);
      log.debug({ extracted }, 'Extracted Reverb order ID from URL (order_id was null)');
      return extracted;
    }
  }

  return null;
}

/**
 * Reverb orders are single-item — the sold listing is at dto.listing.
 *
 * The SKU carried here is what InventoryConsistencyService uses to find the
 * matching Product and deduct stock, so losing it means the sale is recorded
 * but inventory never moves.
 */
function mapLineItems(dto: ReverbOrderDto, resolvedOrderId: string): OrderLineItemJson[] {
  const listing = dto.listing;

  if (!listing) {
    log.warn({ orderId: resolvedOrderId }, 'Reverb order has no listing object — line items empty');
    return [];
  }

  const quantity = dto.quantity !== undefined && dto.quantity > 0 ? dto.quantity : 1;
  const unitPrice = parseMoney(dto.amount_product);

  return [
    {
      productId: null,
      externalListingId: listing.id ?? null,
      sku: listing.sku ?? null,
      title: listing.title ?? null,
      quantity,
      unitPrice,
      lineTotal: null,
    },
  ];
}

/**
 * Splits Reverb's single `buyer_name` into first and last.
 *
 * Split on the FIRST space only, so "Mary Jane Watson" yields
 * firstName="Mary", lastName="Jane Watson" rather than dropping a name part.
 */
function mapBuyerInfo(dto: ReverbOrderDto): BuyerInfoJson {
  let firstName = '';
  let lastName = '';

  if (dto.buyer_name) {
    const spaceIndex = dto.buyer_name.indexOf(' ');
    if (spaceIndex === -1) {
      firstName = dto.buyer_name;
    } else {
      firstName = dto.buyer_name.slice(0, spaceIndex);
      lastName = dto.buyer_name.slice(spaceIndex + 1);
    }
  }

  return {
    externalBuyerId: dto.buyer_id ?? null,
    username: dto.buyer_name ?? null,
    email: dto.buyer_email ?? null,
    firstName,
    lastName,
    phone: null,
  };
}

function mapShippingAddress(addr: ReverbShippingAddressDto | undefined): ShippingAddressJson | null {
  if (!addr) return null;

  return {
    line1: addr.street_address ?? null,
    line2: addr.extended_address ?? null,
    city: addr.locality ?? null,
    state: addr.region ?? null,
    postalCode: addr.postal_code ?? null,
    country: addr.country_code ?? null,
  };
}

/** Money as a decimal STRING. Defaults to "0" when absent, matching BigDecimal.ZERO. */
function parseMoney(price: ReverbPrice | undefined): string {
  if (!price?.amount) return '0';

  if (!/^-?\d+(\.\d+)?$/.test(price.amount)) {
    log.warn({ amount: price.amount }, 'Could not parse Reverb price amount');
    return '0';
  }

  return price.amount;
}

/**
 * Returns null for an absent or unparseable date — deliberately NOT the current
 * time.
 *
 * An earlier version of the Java mapper fell back to Instant.now(), which set
 * createdAt to the processing time rather than the real order time and quietly
 * corrupted order-date analytics. Null is the honest answer.
 */
function parseDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;

  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) {
    log.warn({ dateStr }, 'Could not parse Reverb date');
    return null;
  }

  return parsed.toISOString();
}
