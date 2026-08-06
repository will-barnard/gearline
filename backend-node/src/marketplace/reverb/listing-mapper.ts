import type { ProductCondition, ProductRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import type { PublishListingRequest } from '../types.js';

const log = loggerFor('reverb-listing-mapper');

/**
 * Port of ReverbListingMapper — internal domain → Reverb API request body.
 *
 * All override arbitration happens upstream in ListingAttributeResolver; this
 * only handles Reverb's field naming and its required-field fallbacks.
 *
 * Reference: https://reverb.com/api#listings
 */

/**
 * Maps ProductCondition to Reverb condition slugs.
 *
 * Written as a Record rather than a switch so TypeScript enforces
 * exhaustiveness: adding a ProductCondition without a Reverb slug becomes a
 * compile error instead of a runtime fallback to "used", which would silently
 * misrepresent an item's condition on a live listing.
 */
const CONDITION_SLUGS: Record<ProductCondition, string> = {
  NEW: 'brand-new',
  MINT: 'mint',
  EXCELLENT: 'excellent',
  VERY_GOOD: 'very-good',
  GOOD: 'good',
  FAIR: 'fair',
  POOR: 'poor',
  OPEN_BOX: 'b-stock',
  USED: 'used',
  FOR_PARTS: 'non-functioning',
};

export function mapCondition(condition: ProductCondition | null): string {
  if (!condition) return 'used';
  return CONDITION_SLUGS[condition] ?? 'used';
}

function getString(map: Record<string, unknown>, key: string): string | null {
  const value = map[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Builds the Reverb create/update body.
 *
 * Returns the payload wrapped as `{ listing: {...} }`, which is what the Reverb
 * API expects.
 */
export function toReverbRequest(
  product: ProductRow,
  request: PublishListingRequest,
): Record<string, unknown> {
  const listing: Record<string, unknown> = {};
  const extra = request.extraParams ?? {};

  // ── Core fields ────────────────────────────────────────────────────────────

  listing['title'] = request.titleOverride ?? product.title;

  // Description falls back to the TITLE, not to empty — Reverb rejects
  // listings with no description.
  listing['description'] = request.descriptionOverride ?? product.description ?? product.title;

  const price = request.priceOverride ?? product.price;
  listing['price'] = { amount: price, currency: 'USD' };

  /**
   * Reverb needs BOTH fields, and `inventory` is a FLAT integer here — not the
   * nested { total: n } object used elsewhere in their API.
   *
   * Note that inventory: 0 ENDS the listing on Reverb. That is why
   * InventoryConsistencyService enqueues LISTING_DELIST at zero rather than an
   * inventory sync — the two paths would otherwise both end the listing, but
   * only one of them records that fact in our database.
   */
  listing['has_inventory'] = true;
  listing['inventory'] = request.quantity;

  listing['condition'] = { slug: mapCondition(product.condition) };

  // Reverb REQUIRES make and model to publish. Falling back to "Unknown" is
  // what the Java version did — an omitted make is rejected outright, whereas
  // "Unknown" at least produces a live listing the operator can correct.
  listing['make'] = product.brand ?? 'Unknown';
  listing['sku'] = product.sku;

  // ── Instrument attributes (from extraParams passthrough) ───────────────────

  // condition_description: listing override → product.condition_notes
  const conditionNotes = getString(extra, 'reverb_condition_notes') ?? product.condition_notes;
  if (conditionNotes && conditionNotes.trim() !== '') {
    listing['condition_description'] = conditionNotes;
  }

  // model: override → product.model → product.category → product.title
  // The cascade exists because model is mandatory and the last fallback always
  // yields something non-empty.
  listing['model'] =
    getString(extra, 'reverb_model') ?? product.model ?? product.category ?? product.title;

  const year = getString(extra, 'reverb_year') ?? product.year_made;
  if (year) listing['year'] = year;

  const finish = getString(extra, 'reverb_finish') ?? product.finish;
  if (finish) listing['finish'] = finish;

  // ── Video ──────────────────────────────────────────────────────────────────

  const videoUrl = getString(extra, 'reverb_video_url') ?? product.video_url;
  if (videoUrl && videoUrl.trim() !== '') {
    listing['video_link'] = videoUrl;
  }

  // ── Photos ─────────────────────────────────────────────────────────────────

  // A plain array of URL strings — NOT [{ source: url }]. The object form is
  // accepted by the API and then silently produces a listing with no photos.
  if (request.imageUrls.length > 0) {
    listing['photos'] = [...request.imageUrls];
  }

  // ── Category ───────────────────────────────────────────────────────────────

  if (request.categoryId) {
    listing['categories'] = [{ uuid: request.categoryId }];
  }

  // ── Shipping ───────────────────────────────────────────────────────────────

  const shipping = request.shippingDetails;

  if (shipping) {
    if (shipping.shippingProfileName) {
      /**
       * The value held in shippingProfileName is Reverb's numeric profile ID
       * from GET /shop, and the API field is `shipping_profile_id` — not
       * `_name`, despite the internal field being called that. The naming
       * mismatch is inherited; renaming the internal field would mean touching
       * every stored listing_overrides key.
       *
       * A profile takes precedence over explicit weight/dimensions.
       */
      listing['shipping_profile_id'] = shipping.shippingProfileName;
    } else {
      buildShippingBlock(listing, shipping);
    }
  } else {
    log.warn({ sku: product.sku }, 'Product has no shipping data — Reverb listing may be incomplete');
  }

  // ── Remaining passthrough keys ─────────────────────────────────────────────

  // Anything not already consumed and not prefixed for a specific marketplace
  // is forwarded verbatim, so a new Reverb field can be used from
  // listing_overrides without a code change.
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith('reverb_') || key.startsWith('ebay_')) continue;
    if (key in listing) continue;
    listing[key] = value;
  }

  return { listing };
}

/**
 * Emits Reverb's weight block, plus a dimensions block when ALL THREE
 * dimensions are present.
 *
 * The all-or-nothing rule on dimensions is deliberate: Reverb rejects a partial
 * dimensions object, so sending length and width without height fails the whole
 * publish rather than degrading gracefully.
 *
 *   "weight":     { "value": "16.000", "unit": "oz" }
 *   "dimensions": { "length": "24.000", "width": "12.000", "height": "8.000", "unit": "in" }
 */
function buildShippingBlock(
  listing: Record<string, unknown>,
  shipping: NonNullable<PublishListingRequest['shippingDetails']>,
): void {
  if (shipping.weightOz !== null) {
    listing['weight'] = { value: shipping.weightOz, unit: 'oz' };
  }

  const { lengthIn, widthIn, heightIn } = shipping;

  if (lengthIn !== null && widthIn !== null && heightIn !== null) {
    listing['dimensions'] = {
      length: lengthIn,
      width: widthIn,
      height: heightIn,
      unit: 'in',
    };
  }
}
