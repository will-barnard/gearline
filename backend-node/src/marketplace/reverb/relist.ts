import type { MarketplaceListingRow } from '../../db/types.js';

/**
 * Rules for relisting a Reverb listing after a sale.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Reverb treats every condition below Brand New / B-Stock / Mint-with-inventory
 * as a one-of-a-kind item. After its first sale such a listing is locked in
 * "Ordered" for good: it cannot hold more than one unit, and no inventory
 * update revives it. Gearline's usual top-up after a sale (set the quantity back
 * to what is still for sale) therefore does nothing for a used-condition item
 * that we can sell again — a special-order part, or stock of several identical
 * units.
 *
 * So for those listings the next unit has to be a NEW Reverb listing. The row in
 * marketplace_listings is reused (one row per product per account); only its
 * external id moves, and the old ids are kept in metadata so a late order for an
 * earlier unit can still be traced to its product. Same shape as Gear Exchange.
 *
 * ── Why the new listing gets a different SKU ─────────────────────────────────
 *
 * Reverb requires unique SKUs, and the locked listing keeps holding its own. The
 * relisted unit therefore carries `<sku>-R1`, `<sku>-R2`, … Orders for it are
 * matched back to the product by Reverb listing id (connector.ts), never by
 * SKU, so deduction, restocking and the Shopify mirror order keep working.
 */

export const PREVIOUS_IDS_KEY = 'reverb_previous_listing_ids';
export const RELIST_SKU_KEY = 'reverb_sku';

/** Listing states from which Reverb will not take the item back after a sale. */
const LOCKED_BY_SALE_STATES = new Set(['sold', 'ordered', 'sold_out', 'sold-out']);

/**
 * Condition slugs that are single-unit on Reverb. A POSITIVE list on purpose:
 * Brand New, B-Stock and Mint-with-inventory can be restocked (and Reverb relists
 * them itself), and a slug we do not recognise must never trigger a duplicate
 * listing.
 */
const SINGLE_UNIT_CONDITIONS = new Set([
  'mint',
  'excellent',
  'very-good',
  'good',
  'fair',
  'poor',
  'non-functioning',
]);

export function isLockedBySale(stateSlug: string | null | undefined): boolean {
  return !!stateSlug && LOCKED_BY_SALE_STATES.has(stateSlug.toLowerCase());
}

export function isSingleUnitCondition(conditionSlug: string | null | undefined): boolean {
  return !!conditionSlug && SINGLE_UNIT_CONDITIONS.has(conditionSlug.toLowerCase());
}

/**
 * Should this listing be replaced by a new one?
 *
 * Only when more units are for sale (`quantityForSale > 0`), the listing is
 * locked by its sale, AND its condition cannot be restocked. An ended listing is
 * deliberately not relisted — somebody (or Gearline's own delist) ended it.
 */
export function needsRelist(
  listing: { state: string | null; conditionSlug: string | null },
  quantityForSale: number,
): boolean {
  return (
    quantityForSale > 0 && isLockedBySale(listing.state) && isSingleUnitCondition(listing.conditionSlug)
  );
}

/** Ids of Reverb listings this row used to point at (each one sold). */
export function previousListingIds(
  row: Pick<MarketplaceListingRow, 'marketplace_metadata'> | undefined | null,
): string[] {
  const raw = row?.marketplace_metadata?.[PREVIOUS_IDS_KEY];
  return Array.isArray(raw) ? raw.map((v) => String(v)) : [];
}

/** Every Reverb listing id this row has ever pointed at, current one first. */
export function allListingIds(
  row: Pick<MarketplaceListingRow, 'external_listing_id' | 'marketplace_metadata'>,
): string[] {
  return [...(row.external_listing_id ? [row.external_listing_id] : []), ...previousListingIds(row)];
}

/** `CLAV-D6-FRAME` after its first sale → `CLAV-D6-FRAME-R1`, then `-R2`, … */
export function relistSku(productSku: string, soldListingIds: string[]): string {
  return `${productSku}-R${soldListingIds.length}`;
}
