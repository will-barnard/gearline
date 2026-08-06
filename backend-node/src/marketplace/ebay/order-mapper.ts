import type { BuyerInfoJson, OrderLineItemJson, ShippingAddressJson } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { decimalToString, multiplyDecimal, parseDecimal, tryParseDecimal } from '../../util/decimal.js';
import type { ImportedOrder } from '../types.js';

const log = loggerFor('ebay-order-mapper');

/**
 * Maps an eBay Fulfillment API order to ImportedOrder. Port of EbayOrderMapper.
 *
 * The response is deeply nested and heavily optional — the shipping address
 * alone sits at:
 *   fulfillmentStartInstructions[0].shippingStep.shipTo.contactAddress
 *
 * Every level is navigated defensively; a malformed order returns null rather
 * than throwing, so one bad order cannot abort a whole polling batch.
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** eBay money nodes are { value: "1500.00", currency: "USD" }. */
function extractAmount(node: unknown): string | null {
  const money = asObject(node);
  if (!money) return null;

  const value = money['value'];
  if (value === null || value === undefined) return null;

  const text = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    log.warn({ value: text }, 'Could not parse eBay amount');
    return null;
  }

  return text;
}

function extractAmountOrZero(node: unknown): string {
  return extractAmount(node) ?? '0';
}

function extractCurrency(pricing: Json): string {
  // Any of these nodes carries the currency; take the first present.
  for (const key of ['priceSubtotal', 'deliveryCost', 'total', 'tax']) {
    const node = asObject(pricing[key]);
    const currency = node ? asString(node['currency']) : null;
    if (currency) return currency;
  }
  return 'USD';
}

function toInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** Splits "First Last" on the FIRST space, so multi-word surnames survive. */
function splitName(fullName: string | null): [string, string] {
  if (!fullName || fullName.trim() === '') return ['', ''];

  const space = fullName.indexOf(' ');
  if (space < 0) return [fullName, ''];

  return [fullName.slice(0, space), fullName.slice(space + 1)];
}

export function map(raw: Json | null): ImportedOrder | null {
  if (!raw) return null;

  try {
    const orderId = asString(raw['orderId']);

    if (!orderId) {
      log.warn('eBay order has no orderId — skipping');
      return null;
    }

    // ── Buyer ────────────────────────────────────────────────────────────────
    let buyerInfo: BuyerInfoJson | null = null;
    const buyer = asObject(raw['buyer']);

    if (buyer) {
      const username = asString(buyer['username']);
      const regAddr = asObject(buyer['buyerRegistrationAddress']);

      const fullName = regAddr ? asString(regAddr['fullName']) : null;
      const email = regAddr ? asString(regAddr['email']) : null;
      const primaryPhone = regAddr ? asObject(regAddr['primaryPhone']) : null;
      const phone = primaryPhone ? asString(primaryPhone['phoneNumber']) : null;

      const [firstName, lastName] = splitName(fullName);

      buyerInfo = {
        // eBay exposes no stable numeric buyer ID here, so the username doubles
        // as the external identifier — matching the Java behaviour.
        externalBuyerId: username,
        username,
        email,
        firstName,
        lastName,
        phone,
      };
    }

    // ── Shipping address ─────────────────────────────────────────────────────
    let shippingAddress: ShippingAddressJson | null = null;

    const instructions = asArray(raw['fulfillmentStartInstructions']);
    const firstInstruction = asObject(instructions[0]);
    const shippingStep = firstInstruction ? asObject(firstInstruction['shippingStep']) : null;
    const shipTo = shippingStep ? asObject(shippingStep['shipTo']) : null;
    const addr = shipTo ? asObject(shipTo['contactAddress']) : null;

    if (addr) {
      shippingAddress = {
        line1: asString(addr['addressLine1']),
        line2: asString(addr['addressLine2']),
        city: asString(addr['city']),
        state: asString(addr['stateOrProvince']),
        postalCode: asString(addr['postalCode']),
        country: asString(addr['countryCode']),
      };
    }

    // ── Line items ───────────────────────────────────────────────────────────
    const lineItems: OrderLineItemJson[] = [];

    for (const rawItem of asArray(raw['lineItems'])) {
      const item = asObject(rawItem);
      if (!item) continue;

      const quantity = toInt(item['quantity']) ?? 1;
      const unitPrice = extractAmount(item['lineItemCost']);

      // lineTotal = unitPrice x quantity, computed exactly.
      let lineTotal: string | null = null;
      const parsedUnit = tryParseDecimal(unitPrice);
      if (parsedUnit) {
        lineTotal = decimalToString(multiplyDecimal(parsedUnit, parseDecimal(String(quantity))));
      }

      lineItems.push({
        productId: null,
        /**
         * eBay's lineItemId, stored in externalListingId.
         *
         * This is load-bearing beyond identification: marking the order shipped
         * later requires these IDs in the shippingFulfillment payload. An order
         * imported without them cannot be fulfilled through the API.
         */
        externalListingId: asString(item['lineItemId']),
        sku: asString(item['sku']),
        title: asString(item['title']),
        quantity,
        unitPrice,
        lineTotal,
      });
    }

    // ── Pricing ──────────────────────────────────────────────────────────────
    const pricing = asObject(raw['pricingSummary']);

    const subtotal = pricing ? extractAmountOrZero(pricing['priceSubtotal']) : '0';
    const shippingTotal = pricing ? extractAmountOrZero(pricing['deliveryCost']) : '0';
    const taxTotal = pricing ? extractAmountOrZero(pricing['tax']) : '0';
    const totalAmount = pricing ? extractAmountOrZero(pricing['total']) : '0';
    const currency = pricing ? extractCurrency(pricing) : 'USD';

    // ── Created date ─────────────────────────────────────────────────────────
    /**
     * The Java version fell back to Instant.now() on a missing/unparseable
     * date. Null is used here instead, consistent with the Reverb mapper —
     * a wrong timestamp silently corrupts order-date reporting, whereas a null
     * is visibly absent.
     */
    let createdAt: string | null = null;
    const creationDate = asString(raw['creationDate']);

    if (creationDate) {
      const parsed = new Date(creationDate);
      if (Number.isNaN(parsed.getTime())) {
        log.warn({ creationDate, orderId }, 'Could not parse eBay creationDate');
      } else {
        createdAt = parsed.toISOString();
      }
    }

    return {
      externalOrderId: orderId,
      marketplaceOrderUrl: `https://www.ebay.com/order/${orderId}`,
      lineItems,
      subtotal,
      shippingTotal,
      taxTotal,
      totalAmount,
      currency,
      buyerInfo,
      shippingAddress,
      createdAt,
    };
  } catch (err) {
    // One malformed order must not abort a polling batch.
    log.error({ err }, 'Failed to map eBay order');
    return null;
  }
}
