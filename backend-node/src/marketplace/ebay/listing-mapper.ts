import type { ProductCondition, ProductRow } from '../../db/types.js';
import { compareDecimal, parseDecimal } from '../../util/decimal.js';
import type { PublishListingRequest } from '../types.js';

/**
 * Builds eBay Inventory API request bodies. Extracted from EbayConnector.
 *
 * Two separate bodies, and putting a field on the wrong one is the most common
 * eBay integration mistake:
 *
 *   INVENTORY ITEM — what the thing IS: title, description, images, condition,
 *                    aspects (item specifics), package weight and dimensions.
 *   OFFER          — how it SELLS: price, quantity, category, policies, location.
 *
 * Item specifics in particular belong on `product.aspects` of the INVENTORY
 * ITEM, not on the offer. eBay accepts the offer either way and simply drops
 * them, so the listing publishes successfully with no specifics and no error.
 */

const MARKETPLACE_ID = 'EBAY_US';

/** eBay caps the product block at 12 image URLs. */
const MAX_IMAGE_URLS = 12;

/**
 * Weight above which the package is classed as freight rather than parcel.
 * 320 oz = 20 lb.
 */
const VERY_LARGE_PACKAGE_OZ = parseDecimal('320');

/**
 * ProductCondition → eBay Inventory API condition enum.
 *
 * A Record rather than a switch, so a new ProductCondition without a mapping is
 * a compile error instead of a silent fallback.
 *
 * NOTE the `USED_` prefixes. Bare "VERY_GOOD", "GOOD" and "ACCEPTABLE" are NOT
 * valid eBay values and are rejected with a 400 that does not explain why.
 */
const EBAY_CONDITIONS: Record<ProductCondition, string> = {
  NEW: 'NEW',
  OPEN_BOX: 'NEW_OTHER',
  MINT: 'LIKE_NEW',
  EXCELLENT: 'USED_EXCELLENT',
  VERY_GOOD: 'USED_VERY_GOOD',
  GOOD: 'USED_GOOD',
  FAIR: 'USED_ACCEPTABLE',
  USED: 'USED_ACCEPTABLE',
  POOR: 'FOR_PARTS_OR_NOT_WORKING',
  FOR_PARTS: 'FOR_PARTS_OR_NOT_WORKING',
};

export function mapEbayCondition(condition: ProductCondition | null): string {
  if (!condition) return 'USED_EXCELLENT';
  return EBAY_CONDITIONS[condition] ?? 'USED_EXCELLENT';
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Builds PUT /sell/inventory/v1/inventory_item/{sku}.
 *
 * This is a FULL REPLACE, not a merge — every field must be present on every
 * call or it is cleared from the live listing.
 */
export function buildInventoryItemBody(
  product: ProductRow,
  request: PublishListingRequest,
): Record<string, unknown> {
  const extra = request.extraParams ?? {};

  // ── product block ──────────────────────────────────────────────────────────
  const productBlock: Record<string, unknown> = {
    title: request.titleOverride ?? product.title,
  };

  const description = request.descriptionOverride ?? product.description;
  if (description !== null && description !== undefined) {
    productBlock['description'] = description;
  }

  const imageUrls = request.imageUrls.length > 0 ? request.imageUrls : (product.image_urls ?? []);
  if (imageUrls.length > 0) {
    productBlock['imageUrls'] = imageUrls.slice(0, MAX_IMAGE_URLS);
  }

  /**
   * Aspects (item specifics). eBay expects Record<string, string[]> — the value
   * is always an ARRAY even for a single value; a bare string is rejected.
   *
   * Auto-populated from product fields, then caller-supplied specifics are
   * merged over the top so an explicit override always wins.
   */
  const aspects: Record<string, string[]> = {};

  if (nonEmpty(product.brand)) aspects['Brand'] = [product.brand];
  if (nonEmpty(product.model)) aspects['Model'] = [product.model];
  if (nonEmpty(product.year_made)) aspects['Year Manufactured'] = [product.year_made];
  if (nonEmpty(product.finish)) aspects['Color'] = [product.finish];

  const specifics = extra['ebay_item_specifics'];
  if (typeof specifics === 'object' && specifics !== null && !Array.isArray(specifics)) {
    for (const [key, value] of Object.entries(specifics as Record<string, unknown>)) {
      // Accept both a plain string and an already-array value.
      aspects[key] = Array.isArray(value) ? value.map(String) : [String(value)];
    }
  }

  if (Object.keys(aspects).length > 0) productBlock['aspects'] = aspects;

  const body: Record<string, unknown> = { product: productBlock };

  // ── condition ──────────────────────────────────────────────────────────────
  body['condition'] = mapEbayCondition(product.condition);

  const conditionOverride = extra['ebay_condition_description'];
  const conditionDescription = nonEmpty(
    typeof conditionOverride === 'string' ? conditionOverride : null,
  )
    ? (conditionOverride as string)
    : nonEmpty(product.condition_notes)
      ? product.condition_notes
      : null;

  if (conditionDescription) body['conditionDescription'] = conditionDescription;

  // ── package weight and size ────────────────────────────────────────────────
  const shipping = request.shippingDetails;

  if (shipping) {
    const packageInfo: Record<string, unknown> = {};

    if (shipping.weightOz !== null) {
      packageInfo['weight'] = { value: shipping.weightOz, unit: 'OUNCE' };
    }

    const hasDimensions =
      shipping.lengthIn !== null && shipping.widthIn !== null && shipping.heightIn !== null;

    if (hasDimensions) {
      packageInfo['dimensions'] = {
        length: shipping.lengthIn,
        width: shipping.widthIn,
        height: shipping.heightIn,
        unit: 'INCH',
      };

      /**
       * packageType drives eBay's carrier eligibility checks. Calling a 30 lb
       * guitar a MAILING_BOX produces wrong shipping quotes at checkout, so the
       * threshold is applied on exact decimals rather than a float compare.
       */
      let packageType = 'MAILING_BOX';

      if (shipping.weightOz !== null) {
        const weight = parseDecimal(shipping.weightOz);
        if (compareDecimal(weight, VERY_LARGE_PACKAGE_OZ) > 0) {
          packageType = 'VERY_LARGE_PACKAGE';
        }
      }

      packageInfo['packageType'] = packageType;
    }

    if (Object.keys(packageInfo).length > 0) body['packageWeightAndSize'] = packageInfo;
  }

  // ── availability ───────────────────────────────────────────────────────────
  body['availability'] = {
    shipToLocationAvailability: { quantity: request.quantity },
  };

  return body;
}

/**
 * Builds POST /sell/inventory/v1/offer or PUT /offer/{offerId}.
 *
 * merchantLocationKey is REQUIRED before an offer can be published. Without it
 * the publish call fails with an error that does not name the missing field —
 * which is why the settings screen surfaces it as an account-level default.
 */
export function buildOfferBody(
  sku: string,
  product: ProductRow,
  request: PublishListingRequest,
): Record<string, unknown> {
  const extra = request.extraParams ?? {};

  const price = request.priceOverride ?? product.price;

  const body: Record<string, unknown> = {
    sku,
    marketplaceId: MARKETPLACE_ID,
    format: 'FIXED_PRICE',
    pricingSummary: {
      // Decimal string — never a JS number.
      price: { value: price, currency: 'USD' },
    },
    availableQuantity: request.quantity,
  };

  if (request.categoryId) body['categoryId'] = request.categoryId;

  const policies: Record<string, unknown> = {};

  const fulfillmentPolicy = extra['ebay_fulfillment_policy_id'];
  const returnPolicy = extra['ebay_return_policy_id'];
  const paymentPolicy = extra['ebay_payment_policy_id'];

  if (fulfillmentPolicy !== null && fulfillmentPolicy !== undefined) {
    policies['fulfillmentPolicyId'] = String(fulfillmentPolicy);
  }
  if (returnPolicy !== null && returnPolicy !== undefined) {
    policies['returnPolicyId'] = String(returnPolicy);
  }
  if (paymentPolicy !== null && paymentPolicy !== undefined) {
    policies['paymentPolicyId'] = String(paymentPolicy);
  }

  if (Object.keys(policies).length > 0) body['listingPolicies'] = policies;

  const locationKey = extra['ebay_merchant_location_key'];
  if (locationKey !== null && locationKey !== undefined) {
    body['merchantLocationKey'] = String(locationKey);
  }

  // Item specifics are deliberately NOT here — see the file header.

  return body;
}
