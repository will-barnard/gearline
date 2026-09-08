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
 * Maps ProductCondition to a Reverb condition NAME.
 *
 * ── Reverb offers exactly eight, identified by display name ──────────────────
 *
 * Brand New, Mint, Excellent, Very Good, Good, Fair, Poor, Non Functioning.
 * GET /listing_conditions returns only `uuid`, `display_name` and
 * `description` — there is no `slug` field, and the earlier slug-shaped values
 * here were invented. Three of them named nothing at all:
 *
 *   'b-stock'         — Reverb retired B-Stock
 *   'used'            — never existed
 *   'used' (default)  — likewise, and it was the fallback for a null condition
 *
 * 'used' was the worst of the three, because it is what the Shopify importer
 * stamps on every product it creates. Every Shopify-sourced listing resolved to
 * a condition Reverb has never heard of.
 *
 * ── The two judgement calls ─────────────────────────────────────────────────
 *
 * USED and OPEN_BOX have no Reverb equivalent, so they are mapped by meaning:
 *
 *   USED     -> Good. Reverb's Good is "functional with visible wear" — the
 *               honest middle. A bare USED carries no evidence for anything
 *               better, and understating beats overstating on a listing a
 *               buyer can dispute. Also the fallback for a missing condition.
 *   OPEN_BOX -> Mint. Reverb's own wording for Mint is "essentially new
 *               original condition but have been opened or played", which is
 *               what open-box means.
 *
 * Written as a Record rather than a switch so TypeScript enforces
 * exhaustiveness: adding a ProductCondition without a Reverb condition becomes
 * a compile error rather than a silent misrepresentation on a live listing.
 */
const CONDITION_NAMES: Record<ProductCondition, string> = {
  NEW: 'Brand New',
  MINT: 'Mint',
  EXCELLENT: 'Excellent',
  VERY_GOOD: 'Very Good',
  GOOD: 'Good',
  FAIR: 'Fair',
  POOR: 'Poor',
  OPEN_BOX: 'Mint',
  USED: 'Good',
  FOR_PARTS: 'Non Functioning',
};

export function mapCondition(condition: ProductCondition | null): string {
  if (!condition) return 'Good';
  return CONDITION_NAMES[condition] ?? 'Good';
}

function getString(map: Record<string, unknown>, key: string): string | null {
  const value = map[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Builds the Reverb create/update body.
 *
 * Returns a FLAT object — the fields sit at the top level of the request body.
 *
 * This used to return `{ listing: {...} }`. Reverb is a Rails app, and sending
 * that envelope defeats its ParamsWrapper: because the body already has a
 * `listing` key, Rails skips wrapping and the controller reads the top level,
 * which is then empty. Nothing 400s — Reverb falls through to its make/model
 * guesser, which has no title to guess from, and the publish dies on
 * "Localized contents model for English can't be blank" with an echoed listing
 * showing make "Unknown", a blank model and a $0.00 price.
 *
 * `conditionUuid` is resolved by the caller rather than looked up here, so this
 * stays a pure synchronous mapping with no network of its own.
 *
 * Reference: https://www.reverb-api.com/docs/create-listings
 */
export function toReverbRequest(
  product: ProductRow,
  request: PublishListingRequest,
  conditionUuid: string,
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

  /**
   * Reverb identifies conditions by UUID, not slug — `{ slug: 'excellent' }` is
   * rejected with `400 condition[uuid] is missing`. The caller resolves the
   * slug from mapCondition() / the condition_mapping override through
   * conditions.ts, which reads the live catalogue.
   */
  listing['condition'] = { uuid: conditionUuid };

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

  return listing;
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
