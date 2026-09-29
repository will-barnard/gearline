import type { MarketplaceAccountRow, MarketplaceType, ProductRow } from '../db/types.js';

/**
 * Whether a product may be listed on a given marketplace account.
 *
 * ── Why one function ─────────────────────────────────────────────────────────
 *
 * Listing stubs are created in three places (Shopify webhooks, the new-account
 * backfill, and the manual "publish to" action) and each used to carry its own
 * copy of the `marketplace_excluded` check. Adding a second kind of exclusion
 * to three copies is how one of them gets missed — and the one that gets
 * missed is the one that puts a t-shirt on a marketplace that bans clothing.
 *
 * Three rules, checked in order:
 *
 *   1. products.marketplace_excluded — "never list this anywhere".
 *   2. products.excluded_marketplaces — "never list this on marketplace X".
 *   3. The ACCOUNT's `excluded_product_types` setting — "nothing of Shopify
 *      product type T goes to this account". This is what makes a whole class
 *      of products (every shirt, now and future) stay off Gear Exchange without
 *      anyone remembering to tick a box per product.
 *
 * Shopify is never a listing destination, so it is reported ineligible with a
 * reason rather than silently passed.
 */

export interface Eligibility {
  eligible: boolean;
  /** Operator-facing reason when not eligible. */
  reason: string | null;
}

const OK: Eligibility = { eligible: true, reason: null };

export const MARKETPLACE_LABELS: Record<MarketplaceType, string> = {
  SHOPIFY: 'Shopify',
  EBAY: 'eBay',
  REVERB: 'Reverb',
  GEAR_EXCHANGE: 'Gear Exchange',
};

/** Normalises a product type for comparison — Shopify types are free text. */
function normaliseType(value: string): string {
  return value.trim().toLowerCase();
}

/** The account's excluded product types, normalised. Tolerates a missing or malformed setting. */
export function excludedProductTypes(account: Pick<MarketplaceAccountRow, 'sync_settings'>): string[] {
  const raw = account.sync_settings?.['excluded_product_types'];
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => normaliseType(String(t))).filter((t) => t !== '');
}

export function checkEligibility(
  product: Pick<ProductRow, 'marketplace_excluded' | 'excluded_marketplaces' | 'category'>,
  account: Pick<MarketplaceAccountRow, 'marketplace_type' | 'sync_settings'>,
): Eligibility {
  const type = account.marketplace_type;
  const label = MARKETPLACE_LABELS[type] ?? type;

  if (type === 'SHOPIFY') {
    return { eligible: false, reason: 'Shopify is the product source, not a listing destination' };
  }

  if (product.marketplace_excluded) {
    return { eligible: false, reason: 'Product is excluded from all marketplaces' };
  }

  if ((product.excluded_marketplaces ?? []).includes(type)) {
    return { eligible: false, reason: `Product is excluded from ${label}` };
  }

  const category = product.category ? normaliseType(product.category) : '';
  if (category !== '' && excludedProductTypes(account).includes(category)) {
    return {
      eligible: false,
      reason: `Product type "${product.category}" is excluded on this ${label} account`,
    };
  }

  return OK;
}

export function isEligible(
  product: Pick<ProductRow, 'marketplace_excluded' | 'excluded_marketplaces' | 'category'>,
  account: Pick<MarketplaceAccountRow, 'marketplace_type' | 'sync_settings'>,
): boolean {
  return checkEligibility(product, account).eligible;
}
