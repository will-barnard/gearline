import type { MarketplaceAccountRow, MarketplaceListingRow, ProductRow } from '../db/types.js';
import { loggerFor } from '../logger.js';
import type { PublishListingRequest } from '../marketplace/types.js';
import { resolveShipping } from './shipping-calculator.js';

const log = loggerFor('listing-attribute-resolver');

/**
 * Port of ListingAttributeResolver.
 *
 * Arbitrates listing attributes from three sources, in priority order:
 *
 *   1. Per-listing overrides (listing_overrides JSONB) — highest
 *   2. Canonical product fields
 *   3. Account-level settings (description suffix, eBay defaults)
 *
 * This is the single point that turns the free-form overrides map into a typed
 * PublishListingRequest. Connector mappers apply marketplace-specific naming on
 * top; none of them read listing_overrides directly.
 *
 * ── Recognised override keys ─────────────────────────────────────────────────
 *
 * Generic (all marketplaces):
 *   title, description, price, category_id, condition_mapping, image_urls,
 *   weight_oz_override
 *
 * Reverb:
 *   reverb_shipping_profile_name, reverb_model, reverb_year, reverb_finish
 *
 * eBay:
 *   ebay_fulfillment_policy_id, ebay_return_policy_id, ebay_payment_policy_id,
 *   ebay_category_id, ebay_item_specifics, ebay_merchant_location_key
 */

/**
 * Keys consumed here and promoted to typed fields. Everything else falls
 * through to extraParams.
 *
 * The eBay keys are deliberately ABSENT from this list — they must reach the
 * eBay connector via extraParams. Adding one here would silently stop eBay
 * listings from receiving their policy IDs, and eBay rejects offers without
 * them.
 */
const RESOLVED_KEYS = [
  'title',
  'description',
  'price',
  'category_id',
  'condition_mapping',
  'image_urls',
  'weight_oz_override',
  'reverb_shipping_profile_name',
] as const;

/**
 * Account-level eBay defaults merged into extraParams when the listing has no
 * per-listing value. Lets the operator configure merchant location, fulfillment
 * policy and return policy once on the Marketplaces page instead of per listing.
 */
const EBAY_ACCOUNT_DEFAULT_KEYS = [
  'ebay_merchant_location_key',
  'ebay_fulfillment_policy_id',
  'ebay_return_policy_id',
] as const;

function getString(map: Record<string, unknown>, key: string): string | null {
  const value = map[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Reads a decimal override as a STRING, never a number.
 *
 * Java parsed these with `new BigDecimal(val.toString())` and logged+ignored a
 * NumberFormatException. Same here: an unparseable override is dropped with a
 * warning rather than failing the publish, so one bad override cannot block a
 * listing from going out.
 */
function getDecimalString(map: Record<string, unknown>, key: string): string | null {
  const value = map[key];
  if (value === null || value === undefined) return null;

  const text = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    log.warn({ key, value }, 'Invalid decimal in listing_overrides — ignoring');
    return null;
  }
  return text;
}

/**
 * Description resolution: override, else product description, then the
 * account-level suffix appended as its own paragraph.
 *
 * The suffix is applied AFTER the override so it is always present regardless
 * of whether a per-listing description was set. That ordering is intentional —
 * the suffix usually carries shop policy text that must appear on every listing.
 */
function resolveDescription(
  overrides: Record<string, unknown>,
  product: ProductRow,
  account: MarketplaceAccountRow | null,
): string | null {
  let base = getString(overrides, 'description');

  if (base === null && product.description && product.description.trim() !== '') {
    base = product.description;
  }

  const settings = account?.sync_settings ?? {};
  const rawSuffix = settings['description_suffix'];
  const suffix = typeof rawSuffix === 'string' && rawSuffix.trim() !== '' ? rawSuffix : null;

  if (suffix === null) return base;
  if (base === null || base.trim() === '') return suffix;
  return `${base}\n\n${suffix}`;
}

function resolveImageUrls(overrides: Record<string, unknown>, product: ProductRow): string[] {
  const override = overrides['image_urls'];

  // An empty array override falls through to the product images rather than
  // publishing a listing with no photos.
  if (Array.isArray(override) && override.length > 0) {
    return override.map((u) => String(u));
  }

  return product.image_urls ?? [];
}

function buildExtraParams(
  overrides: Record<string, unknown>,
  account: MarketplaceAccountRow | null,
  marketplaceType: string,
): Record<string, unknown> {
  const extra: Record<string, unknown> = { ...overrides };
  for (const key of RESOLVED_KEYS) delete extra[key];

  if (marketplaceType === 'EBAY' && account?.sync_settings) {
    const settings = account.sync_settings;

    for (const key of EBAY_ACCOUNT_DEFAULT_KEYS) {
      const existing = extra[key];
      const alreadySet = typeof existing === 'string' && existing.trim() !== '';
      if (alreadySet) continue; // per-listing override always wins

      const accountDefault = settings[key];
      if (typeof accountDefault === 'string' && accountDefault.trim() !== '') {
        extra[key] = accountDefault;
        log.debug({ key, value: accountDefault }, 'Applied eBay account default');
      }
    }
  }

  return extra;
}

export function resolve(
  product: ProductRow,
  listing: Pick<MarketplaceListingRow, 'listing_overrides' | 'marketplace_type'>,
  account: MarketplaceAccountRow | null,
): PublishListingRequest {
  const overrides = listing.listing_overrides ?? {};

  log.debug(
    { sku: product.sku, marketplace: listing.marketplace_type, overrideKeys: Object.keys(overrides) },
    'Resolving listing attributes',
  );

  return {
    titleOverride: getString(overrides, 'title'),
    descriptionOverride: resolveDescription(overrides, product, account),
    priceOverride: getDecimalString(overrides, 'price'),
    quantity: product.quantity,
    imageUrls: resolveImageUrls(overrides, product),
    categoryId: getString(overrides, 'category_id'),
    conditionMapping: getString(overrides, 'condition_mapping'),
    shippingDetails: resolveShipping(product, overrides),
    extraParams: buildExtraParams(overrides, account, listing.marketplace_type),
  };
}

/** Convenience: the effective values a connector should actually publish. */
export function effectiveTitle(request: PublishListingRequest, product: ProductRow): string {
  return request.titleOverride ?? product.title;
}

export function effectivePrice(request: PublishListingRequest, product: ProductRow): string {
  return request.priceOverride ?? product.price;
}
