import type { ProductRow } from '../db/types.js';

/**
 * Special-order products: stock 0, still orderable, delivered after a lead time
 * (a dealer item ordered on demand — the Mellotrons).
 *
 * ── One rule, used everywhere ────────────────────────────────────────────────
 *
 * Gearline treats "quantity 0" as "sold": it delists active listings, holds
 * review stubs, and refuses to publish. That is right for a one-off used
 * instrument and wrong for something we can always order. Rather than teach each
 * of those places about special orders, they all ask channelQuantity() — "how
 * many can a customer buy on a marketplace?" — and the zero-handling follows.
 *
 *   real stock > 0        → real stock (a stocked unit is sold as stock)
 *   real stock 0, special → the configured special-order quantity
 *   real stock 0, normal  → 0 (delist/hold, as before)
 *
 * ── Why not just 1 ───────────────────────────────────────────────────────────
 *
 * A listing at quantity 1 ends when it sells, and an ended Reverb listing has
 * to be created again rather than restocked by an inventory update. At 2 or
 * more, a sale leaves the listing live, the order import then runs
 * propagateInventoryChange, and the listing is topped back up. The default is 2,
 * the smallest value that works that way.
 *
 * ── Where it is configured ───────────────────────────────────────────────────
 *
 * On the Shopify account's sync_settings, next to excluded_tags:
 *
 *   special_order_tags:     ["special-order"]   // default; [] switches it off
 *   special_order_quantity: 2                   // default; 1–25
 *
 * There is deliberately no screen for these yet: the defaults are what Chicago
 * Electric Piano uses, and a settings field nobody has needed is one more thing
 * to keep working. Changing either takes effect per product on its next Shopify
 * update.
 */

export const DEFAULT_SPECIAL_ORDER_TAGS = ['special-order'];
export const DEFAULT_SPECIAL_ORDER_QUANTITY = 2;
const MAX_SPECIAL_ORDER_QUANTITY = 25;

/**
 * Restoration pre-orders carry their own disclaimer and lead time and are
 * handled by other rules. Treating a product with both tags as special order
 * would list it at quantity 2 with no lead-time notice, so it is not.
 */
const NEVER_SPECIAL_ORDER_TAG = 'restoration';

type Settings = Record<string, unknown> | null | undefined;

const normaliseTag = (t: unknown): string => String(t).trim().toLowerCase();

export function specialOrderTags(settings: Settings): string[] {
  const raw = settings?.['special_order_tags'];
  if (!Array.isArray(raw)) return DEFAULT_SPECIAL_ORDER_TAGS;
  return raw.map(normaliseTag).filter((t) => t !== '');
}

export function specialOrderQuantity(settings: Settings): number {
  const raw = Number(settings?.['special_order_quantity']);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_SPECIAL_ORDER_QUANTITY;
  return Math.min(raw, MAX_SPECIAL_ORDER_QUANTITY);
}

/**
 * The special-order quantity for a product from its Shopify tag string
 * (comma-separated, as the webhook and REST API send it), or null when the
 * product is not special order. Matching is case-insensitive and trimmed.
 */
export function specialOrderQuantityFor(tags: string, settings: Settings): number | null {
  const productTags = new Set(
    tags
      .split(',')
      .map(normaliseTag)
      .filter((t) => t !== ''),
  );

  if (productTags.has(NEVER_SPECIAL_ORDER_TAG)) return null;

  const wanted = specialOrderTags(settings);
  if (!wanted.some((t) => productTags.has(t))) return null;

  return specialOrderQuantity(settings);
}

export function isSpecialOrder(product: Pick<ProductRow, 'special_order_quantity'>): boolean {
  return product.special_order_quantity != null;
}

/** How many a customer can buy on a marketplace. See the file comment. */
export function channelQuantity(
  product: Pick<ProductRow, 'quantity' | 'special_order_quantity'>,
): number {
  if (product.quantity > 0) return product.quantity;
  return product.special_order_quantity ?? 0;
}
