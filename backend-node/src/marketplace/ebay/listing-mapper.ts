import type { ProductCondition, ProductRow } from '../../db/types.js';
import { compareDecimal, parseDecimal } from '../../util/decimal.js';
import { PermanentMarketplaceError, type PublishListingRequest } from '../types.js';

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
 * eBay's PackageTypeEnum, in full.
 *
 * Kept as a const set rather than a hand-picked union so the per-listing
 * override can be validated against the real vocabulary. An unknown value is
 * rejected here, with a message naming it — eBay's own answer is a bare 400
 * saying "Could not serialize field [packageWeightAndSize.packageType]", which
 * names neither the value nor the field that produced it.
 *
 * https://developer.ebay.com/api-docs/sell/inventory/types/slr:PackageTypeEnum
 */
const PACKAGE_TYPES = new Set([
  'LETTER', 'BULKY_GOODS', 'CARAVAN', 'CARS', 'EUROPALLET', 'EXPANDABLE_TOUGH_BAGS',
  'EXTRA_LARGE_PACK', 'FURNITURE', 'INDUSTRY_VEHICLES', 'LARGE_CANADA_POSTBOX',
  'LARGE_CANADA_POST_BUBBLE_MAILER', 'LARGE_ENVELOPE', 'MAILING_BOX', 'MEDIUM_CANADA_POST_BOX',
  'MEDIUM_CANADA_POST_BUBBLE_MAILER', 'MOTORBIKES', 'ONE_WAY_PALLET', 'PACKAGE_THICK_ENVELOPE',
  'PADDED_BAGS', 'PARCEL_OR_PADDED_ENVELOPE', 'ROLL', 'SMALL_CANADA_POST_BOX',
  'SMALL_CANADA_POST_BUBBLE_MAILER', 'TOUGH_BAGS', 'UPS_LETTER', 'USPS_FLAT_RATE_ENVELOPE',
  'USPS_LARGE_PACK', 'VERY_LARGE_PACK', 'WINE_PAK',
]);

/**
 * Default for EBAY_US.
 *
 * NOT MAILING_BOX. That value is oriented at the Australian site, and EBAY_US
 * rejects it at publish with `25101 Invalid <ShippingPackage>` and the opaque
 * parameter `err:216305|MailingBoxes`. PACKAGE_THICK_ENVELOPE is the value that
 * is broadly accepted across US categories and carriers.
 *
 * Being wrong here is invisible until publish, and the error names the package
 * type without saying what would be acceptable — so the per-listing override
 * below exists for the cases where even this default is refused.
 */
const DEFAULT_PACKAGE_TYPE = 'PACKAGE_THICK_ENVELOPE';

/** Weight above which the parcel defaults to eBay's freight-ish package type. */
const HEAVY_PACKAGE_TYPE = 'VERY_LARGE_PACK';

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
  body['condition'] = resolveEbayCondition(product, request);

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

      packageInfo['packageType'] = resolvePackageType(request, shipping.weightOz);
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
 * eBay's ConditionEnum, in full.
 *
 * Needed to validate the per-listing override. eBay also restricts WHICH of
 * these a given category accepts — a value can be perfectly valid and still be
 * refused for an organ — so this checks the vocabulary, not the category rules,
 * which only eBay knows.
 */
const EBAY_CONDITION_VALUES = new Set([
  'NEW', 'LIKE_NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS', 'MANUFACTURER_REFURBISHED',
  'CERTIFIED_REFURBISHED', 'EXCELLENT_REFURBISHED', 'VERY_GOOD_REFURBISHED', 'GOOD_REFURBISHED',
  'SELLER_REFURBISHED', 'USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING',
]);

/**
 * The eBay condition for a listing: the override if set, else the product's.
 *
 * `condition_mapping` is the generic per-listing override — the same key the
 * Reverb connector honours — and it was being ignored here, so a category that
 * refuses the mapped condition had no way out short of changing the product.
 */
export function resolveEbayCondition(
  product: ProductRow,
  request: PublishListingRequest,
): string {
  const extra = request.extraParams ?? {};
  const override = extra['ebay_condition'] ?? request.conditionMapping;

  if (typeof override === 'string' && override.trim() !== '') {
    const value = override.trim().toUpperCase();

    if (!EBAY_CONDITION_VALUES.has(value)) {
      throw new PermanentMarketplaceError(
        `"${override}" is not an eBay condition. Valid values are listed at ` +
          'https://developer.ebay.com/api-docs/sell/inventory/types/slr:ConditionEnum',
      );
    }

    return value;
  }

  return mapEbayCondition(product.condition);
}

/**
 * The package type for a listing: the override if set, else by weight.
 *
 * eBay decides whether a package type is acceptable using the listing's
 * category, site and carrier services — rules gearline cannot see and should
 * not try to model. Two attempts to infer it have now been rejected at publish,
 * so the weight rule is only a starting point and `ebay_package_type` is the
 * way out when eBay disagrees.
 *
 * The threshold comparison stays on exact decimals: calling a 30 lb organ a
 * thick envelope produces wrong shipping quotes at checkout, which is worse
 * than a failed publish because it is invisible until someone buys.
 */
export function resolvePackageType(
  request: PublishListingRequest,
  weightOz: string | null,
): string {
  const override = (request.extraParams ?? {})['ebay_package_type'];

  if (typeof override === 'string' && override.trim() !== '') {
    const value = override.trim().toUpperCase();

    if (!PACKAGE_TYPES.has(value)) {
      throw new PermanentMarketplaceError(
        `"${override}" is not an eBay package type. Valid values are listed at ` +
          'https://developer.ebay.com/api-docs/sell/inventory/types/slr:PackageTypeEnum',
      );
    }

    return value;
  }

  if (weightOz !== null && compareDecimal(parseDecimal(weightOz), VERY_LARGE_PACKAGE_OZ) > 0) {
    return HEAVY_PACKAGE_TYPE;
  }

  return DEFAULT_PACKAGE_TYPE;
}

/**
 * The eBay leaf category for a listing.
 *
 * `ebay_category_id` (per listing, set by the category search) wins over the
 * generic `category_id`, which is the marketplace-agnostic override and, on a
 * Reverb listing, holds a Reverb category UUID rather than an eBay id.
 */
export function ebayCategoryId(request: PublishListingRequest): string | null {
  const specific = (request.extraParams ?? {})['ebay_category_id'];

  if (typeof specific === 'string' && specific.trim() !== '') return specific.trim();
  if (typeof specific === 'number') return String(specific);

  return nonEmpty(request.categoryId) ? request.categoryId : null;
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

  /**
   * eBay's leaf category. Publishing without it fails with
   * "missing required input tag <Item.PrimaryCategory.CategoryID>" — and it
   * fails at PUBLISH, after the offer has already been created, which leaves an
   * orphan offer behind. ebayCategoryId() is therefore also checked up front by
   * the connector.
   *
   * `ebay_category_id` comes first because that is what the whole UI writes:
   * the category search on the listing, and the field in the publish modal. It
   * was never read here — the mapper looked only at the generic `category_id`,
   * which nothing on the eBay side sets — so the category picker has never had
   * any effect and every offer went out uncategorised.
   */
  const categoryId = ebayCategoryId(request);
  if (categoryId) body['categoryId'] = categoryId;

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
