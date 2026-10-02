import type { MarketplaceAccountRow, ProductCondition, ProductRow } from '../../db/types.js';
import { effectivePrice, effectiveTitle } from '../../services/listing-attribute-resolver.js';
import { compareDecimal, parseDecimal, tryParseDecimal } from '../../util/decimal.js';
import { PermanentMarketplaceError, type PublishListingRequest } from '../types.js';

/**
 * Builds Gear Exchange listing payloads from the resolved request. Pure — no
 * network, no database — so every rule here is unit-testable.
 *
 * ── Settings this reads ──────────────────────────────────────────────────────
 *
 * Gear Exchange has no seller-level shipping or return "profiles"; every
 * listing carries its own. Gearline therefore takes them from the account's
 * sync_settings, overridable per listing via listing_overrides:
 *
 *   key (listing override / account setting)  meaning
 *   ─────────────────────────────────────────  ───────────────────────────────
 *   gx_shipping_cost                           flat shipping charge, USD
 *   gx_return_policy_days                      return window (one of GX's options)
 *   gx_accepts_offers        "true"/"false"    allow offers
 *   gx_min_offer                               auto-reject offers below this
 *   gx_opted_in_to_sales     "true"/"false"    eligible for GX sale events
 *   gx_local_pickup          "true"/"false"    allow local pickup
 *   gx_delivery  (listing)   ship | pickup | both — overrides the two above;
 *                            "pickup" lists with shipping OFF, no cost needed
 *   gx_payout_method                           one of GX's payout options
 *   gx_brand                 (listing only)    brand when the product has none
 *
 * Settings are stored as strings because the settings endpoint stores strings;
 * they are parsed here.
 */

/** GX rejects prices at or below $25 and above $10,000. */
export const GX_MIN_PRICE_EXCLUSIVE = '25.00';
export const GX_MAX_PRICE_INCLUSIVE = '10000.00';
export const GX_MAX_IMAGES = 25;

/**
 * Internal condition → Gear Exchange condition NAME.
 *
 * GX grades used gear only: Mint, Excellent, Good, Fair, Poor. Names, not IDs —
 * the IDs are not in grade order (the docs' example sends conditionId 3 and
 * gets back "Mint"), so they are looked up from GET /conditions at publish time.
 *
 * Choices worth knowing about:
 *   NEW, OPEN_BOX → Mint. GX has no "new"; Mint is its top grade and is
 *                   defined as like-new with original packaging.
 *   USED          → Good. Matches the Reverb mapping (USED → "Good").
 *   VERY_GOOD     → Excellent. GX has no Very Good; rounding up keeps it above
 *                   GOOD, which is the distinction the operator was making.
 *   FOR_PARTS     → Poor. Poor is GX's "needs repair" grade.
 */
const CONDITION_NAMES: Record<ProductCondition, string> = {
  NEW: 'Mint',
  OPEN_BOX: 'Mint',
  MINT: 'Mint',
  EXCELLENT: 'Excellent',
  VERY_GOOD: 'Excellent',
  GOOD: 'Good',
  USED: 'Good',
  FAIR: 'Fair',
  POOR: 'Poor',
  FOR_PARTS: 'Poor',
};

export function mapCondition(condition: ProductCondition): string {
  return CONDITION_NAMES[condition] ?? 'Good';
}

/**
 * The GX condition a product publishes with, before name -> id resolution:
 *
 *   1. condition_mapping on the listing (a GX condition name or id)
 *   2. gx_condition_map[internal condition] on the account
 *   3. the built-in CONDITION_NAMES default above
 *
 * (2) is how a whole grade is reassigned without touching every listing —
 * e.g. OPEN_BOX, which Reverb publishes as "Mint", may deserve "Excellent"
 * on GX, where Mint means original packaging and protective film.
 */
export function conditionFor(
  product: Pick<ProductRow, 'condition'>,
  request: Pick<PublishListingRequest, 'conditionMapping'>,
  account: Pick<MarketplaceAccountRow, 'sync_settings'>,
): string {
  if (request.conditionMapping && request.conditionMapping.trim() !== '') {
    return request.conditionMapping.trim();
  }

  const map = account.sync_settings?.['gx_condition_map'];
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const mapped = (map as Record<string, unknown>)[product.condition];
    if (typeof mapped === 'string' && mapped.trim() !== '') return mapped.trim();
  }

  return mapCondition(product.condition);
}

// ── Setting helpers ──────────────────────────────────────────────────────────

/** Listing override first, then account setting. Blank counts as unset. */
export function setting(
  request: PublishListingRequest,
  account: Pick<MarketplaceAccountRow, 'sync_settings'>,
  key: string,
): string | null {
  for (const source of [request.extraParams, account.sync_settings ?? {}]) {
    const value = source[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return null;
}

function boolSetting(
  request: PublishListingRequest,
  account: Pick<MarketplaceAccountRow, 'sync_settings'>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = setting(request, account, key);
  if (raw === null) return fallback;
  return raw.toLowerCase() === 'true';
}

// ── Text ─────────────────────────────────────────────────────────────────────

/**
 * Shopify descriptions are HTML. Gear Exchange's listing form is plain text and
 * its API examples are plain text, so markup would show up as literal tags.
 * This is a deliberately small converter: block elements and <br> become line
 * breaks, list items become "- " lines, other tags are dropped, and the common
 * entities are decoded. It is not a sanitiser and does not need to be — the
 * output is plain text going to an API, not HTML going into a page.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    // </li> is deliberately absent: <li> already opened a new line.
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|tr|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * GX displays "brand + title" (titleWithBrand). Shopify titles usually already
 * start with the brand, which would read "Rhodes Rhodes Mark I Tine". Strip a
 * leading brand, case-insensitively, but never down to an empty title.
 */
export function titleWithoutBrand(title: string, brand: string | null): string {
  const t = title.trim();
  if (!brand) return t;

  const b = brand.trim();
  if (b === '' || t.length <= b.length) return t;

  if (t.toLowerCase().startsWith(b.toLowerCase())) {
    const rest = t.slice(b.length).replace(/^[\s\-–—:|,]+/, '');
    return rest === '' ? t : rest;
  }

  return t;
}

/** A 4-digit year GX will accept (1800 or later), else null. */
export function madeYear(yearMade: string | null): number | null {
  if (!yearMade) return null;
  const match = /\b(1[89]\d{2}|20\d{2})\b/.exec(yearMade);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1800 && year <= new Date().getFullYear() + 1 ? year : null;
}

function isYouTube(url: string | null): url is string {
  return !!url && /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url.trim());
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Throws a PermanentMarketplaceError naming the problem when the price is
 * outside GX's allowed range.
 *
 * Checked here rather than left to a 422 so the operator reads "below Gear
 * Exchange's $25 minimum" instead of a raw validation dump — this is the rule
 * most of the small-parts catalogue will hit.
 */
export function assertPriceAllowed(price: string): void {
  const parsed = tryParseDecimal(price);
  if (!parsed) {
    throw new PermanentMarketplaceError(`Price "${price}" is not a valid amount`);
  }

  if (compareDecimal(parsed, parseDecimal(GX_MIN_PRICE_EXCLUSIVE)) <= 0) {
    throw new PermanentMarketplaceError(
      `Price $${price} is at or below Gear Exchange's minimum — listings must be priced above $25. ` +
        'Set a price override on this listing, or exclude the product from Gear Exchange.',
    );
  }

  if (compareDecimal(parsed, parseDecimal(GX_MAX_PRICE_INCLUSIVE)) > 0) {
    throw new PermanentMarketplaceError(
      `Price $${price} is above Gear Exchange's $10,000 maximum.`,
    );
  }
}

// ── Delivery ─────────────────────────────────────────────────────────────────

export interface GxDelivery {
  shippingAllowed: boolean;
  localPickupAllowed: boolean;
}

/**
 * How the buyer gets the item.
 *
 * The per-listing `gx_delivery` override wins: "pickup" for something too big
 * or fragile to ship (a full Rhodes, say), "ship", or "both". Without it the
 * listing ships, with local pickup added when the account allows it.
 */
export function deliveryFor(
  request: PublishListingRequest,
  account: Pick<MarketplaceAccountRow, 'sync_settings'>,
): GxDelivery {
  const mode = (setting(request, account, 'gx_delivery') ?? '').toLowerCase();

  if (mode === 'pickup') return { shippingAllowed: false, localPickupAllowed: true };
  if (mode === 'ship') return { shippingAllowed: true, localPickupAllowed: false };
  if (mode === 'both') return { shippingAllowed: true, localPickupAllowed: true };

  return {
    shippingAllowed: true,
    localPickupAllowed: boolSetting(request, account, 'gx_local_pickup', false),
  };
}

// ── Payload ──────────────────────────────────────────────────────────────────

export interface GxRequestOptions {
  conditionId: string;
  categoryId: string;
  /** Only set on create. Update never changes listing state. */
  publishImmediately?: boolean;
}

/**
 * Builds the create/update body.
 *
 * Everything GX requires for a PUBLISH is validated here even on a draft
 * create, because Gearline only ever creates listings it intends to publish,
 * and failing before the create avoids leaving an unpublishable draft behind.
 */
export function toGxRequest(
  product: ProductRow,
  request: PublishListingRequest,
  account: Pick<MarketplaceAccountRow, 'sync_settings'>,
  options: GxRequestOptions,
): Record<string, unknown> {
  const problems: string[] = [];

  const brand = setting(request, account, 'gx_brand') ?? product.brand?.trim() ?? '';
  if (brand === '') {
    problems.push('a brand (set the Shopify vendor, or a gx_brand override on this listing)');
  }

  const rawDescription = request.descriptionOverride ?? product.description ?? '';
  const description = htmlToText(rawDescription);
  if (description === '') problems.push('a description');

  const images = request.imageUrls.filter((u) => /^https?:\/\//i.test(u)).slice(0, GX_MAX_IMAGES);
  if (images.length === 0) problems.push('at least one image');

  const delivery = deliveryFor(request, account);

  const shippingCost = setting(request, account, 'gx_shipping_cost');
  // A shipping cost only means something when the item ships. Pickup-only
  // listings must not be blocked by a missing one.
  if (delivery.shippingAllowed && (shippingCost === null || !tryParseDecimal(shippingCost))) {
    problems.push('a shipping cost (Gear Exchange account settings, or a gx_shipping_cost override)');
  }

  const returnDays = setting(request, account, 'gx_return_policy_days');
  if (returnDays === null || !/^\d+$/.test(returnDays)) {
    problems.push('a return policy (Gear Exchange account settings, or a gx_return_policy_days override)');
  }

  if (problems.length > 0) {
    throw new PermanentMarketplaceError(`Gear Exchange requires ${problems.join(', ')}.`);
  }

  const price = effectivePrice(request, product);
  assertPriceAllowed(price);

  const body: Record<string, unknown> = {
    title: titleWithoutBrand(effectiveTitle(request, product), brand),
    description,
    brand,
    categoryId: Number(options.categoryId),
    conditionId: Number(options.conditionId),
    price: Number(price),
    // Our product UUID round-trips on every order and webhook, which is how a
    // sale is tied back to the right variant without trusting SKUs.
    productId: product.id,
    sku: product.sku,
    shippingAllowed: delivery.shippingAllowed,
    ...(delivery.shippingAllowed ? { shippingCost: Number(shippingCost) } : {}),
    localPickupAllowed: delivery.localPickupAllowed,
    returnPolicyDays: Number(returnDays),
    acceptsOffers: boolSetting(request, account, 'gx_accepts_offers', false),
    optedInToSales: boolSetting(request, account, 'gx_opted_in_to_sales', false),
    imageUrls: images,
  };

  if (product.serial_number) body['serialNumber'] = product.serial_number;

  const year = madeYear(product.year_made);
  if (year !== null) body['madeYear'] = year;

  if (isYouTube(product.video_url)) body['videoUrl'] = product.video_url.trim();

  const minOffer = setting(request, account, 'gx_min_offer');
  if (minOffer !== null && tryParseDecimal(minOffer)) body['minOffer'] = Number(minOffer);

  const payout = setting(request, account, 'gx_payout_method');
  if (payout !== null) body['payoutMethod'] = payout;

  if (options.publishImmediately !== undefined) {
    body['publishImmediately'] = options.publishImmediately;
  }

  return body;
}
