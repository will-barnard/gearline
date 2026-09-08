import type { MarketplaceAccountRow, ProductRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { PermanentMarketplaceError } from '../types.js';
import * as client from './client.js';

const log = loggerFor('reverb-categories');

/**
 * Resolves a Reverb CATEGORY — what the listing editor calls "product type".
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Reverb will not publish a listing without one, and a listing created without
 * `categories` becomes a draft stuck on "Product type must be specified". The
 * listing itself looks fine; it simply never goes live.
 *
 * Categories are addressed by UUID, and there are hundreds. Making an operator
 * paste a UUID per product is the kind of chore that gets skipped, so the
 * account carries a map of Shopify product type -> Reverb category NAME and the
 * UUIDs are looked up here against the live tree.
 *
 * ── Configuration (marketplace_accounts.sync_settings) ───────────────────────
 *
 *   reverb_category_map: {
 *     "Cables":          "Parts & Accessories / Cables",
 *     "Electric Guitars": "Electric Guitars / Solid Body"
 *   }
 *   reverb_default_category: "Parts & Accessories"   // optional catch-all
 *
 * Values may be a category name or a raw UUID; a UUID passes straight through
 * so an operator who already has one is never forced through the name lookup.
 *
 * Resolution order, highest first:
 *   1. the listing's own `category_id` override
 *   2. reverb_category_map, keyed on the product's Shopify product type
 *   3. reverb_default_category
 *
 * With none of those set the publish fails loudly rather than producing another
 * invisible draft.
 */

const TTL_MS = 60 * 60 * 1000; // 1 hour

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Cache {
  byName: Map<string, string>;
  /** Display names, kept in API order for suggesting near matches. */
  names: string[];
  fetchedAt: number;
}

let cache: Cache | null = null;

/** Test seam. */
export function resetCategoryCache(): void {
  cache = null;
}

function normalise(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/[\s_]+/g, ' ');
}

/**
 * Indexes categories under every name Reverb gives them.
 *
 * `full_name` is the qualified path ("Parts & Accessories / Cables"); `name` is
 * the leaf. Both are indexed, but a leaf name is only registered when it is
 * unambiguous — Reverb reuses leaves like "Other" across many parents, and
 * silently binding one of those would file listings under a category the
 * operator never chose.
 */
function indexCategories(categories: ReadonlyArray<{
  uuid?: string;
  name?: string;
  full_name?: string;
  slug?: string;
}>): Cache {
  const byName = new Map<string, string>();
  const names: string[] = [];
  const leafCounts = new Map<string, number>();

  for (const category of categories) {
    if (!category.uuid) continue;

    const full = category.full_name ?? category.name;
    if (full) {
      byName.set(normalise(full), category.uuid);
      names.push(full);
    }

    if (category.slug) byName.set(normalise(category.slug), category.uuid);

    if (category.name) {
      const leaf = normalise(category.name);
      leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);
    }
  }

  // Second pass: register unambiguous leaves only.
  for (const category of categories) {
    if (!category.uuid || !category.name) continue;

    const leaf = normalise(category.name);
    if (leafCounts.get(leaf) === 1 && !byName.has(leaf)) {
      byName.set(leaf, category.uuid);
    }
  }

  return { byName, names, fetchedAt: Date.now() };
}

async function load(account: MarketplaceAccountRow): Promise<Cache> {
  const loaded = indexCategories(await client.getCategories(account));

  if (loaded.byName.size === 0) {
    throw new PermanentMarketplaceError(
      'Reverb returned no usable categories from GET /categories/flat — ' +
        'cannot resolve a product type for publishing.',
    );
  }

  log.info({ count: loaded.names.length }, 'Loaded Reverb categories');
  return loaded;
}

/**
 * Suggests near matches for an unresolved name.
 *
 * There are hundreds of categories, so dumping the whole list into an error
 * message would bury the answer. Anything sharing a word with the query is
 * usually enough to spot the right spelling.
 */
function suggest(current: Cache, wanted: string): string {
  const tokens = normalise(wanted)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

  const matches = current.names.filter((name) => {
    const haystack = normalise(name);
    return tokens.some((token) => haystack.includes(token));
  });

  if (matches.length === 0) {
    return `No Reverb category resembles it. There are ${current.names.length} to choose from at GET /categories/flat.`;
  }

  const shown = matches.slice(0, 10);
  const more = matches.length - shown.length;

  return `Did you mean: ${shown.join(' | ')}${more > 0 ? ` (and ${more} more)` : ''}?`;
}

/**
 * Returns the UUID for a category name, or passes a UUID straight through.
 *
 * Refreshes the cache on a miss, so a category Reverb adds later resolves on
 * the next attempt rather than needing a redeploy.
 */
export async function resolveCategoryUuid(
  account: MarketplaceAccountRow,
  nameOrUuid: string,
): Promise<string> {
  if (UUID_RE.test(nameOrUuid.trim())) return nameOrUuid.trim();

  const key = normalise(nameOrUuid);
  const stale = cache === null || Date.now() - cache.fetchedAt > TTL_MS;

  if (!stale) {
    const hit = cache?.byName.get(key);
    if (hit) return hit;
  }

  try {
    cache = await load(account);
  } catch (err) {
    // A warm cache beats failing the publish over a transient Reverb blip.
    const hit = cache?.byName.get(key);

    if (hit) {
      log.warn({ err }, 'Could not refresh Reverb categories — using cached values');
      return hit;
    }

    throw err;
  }

  const uuid = cache.byName.get(key);

  if (!uuid) {
    throw new PermanentMarketplaceError(
      `No Reverb category matches "${nameOrUuid}". ${suggest(cache, nameOrUuid)}`,
    );
  }

  return uuid;
}

/**
 * Picks the configured category for a product, before UUID resolution.
 *
 * Returns null when nothing is configured, which the caller turns into a
 * publish failure — Reverb rejects an uncategorised listing anyway, and failing
 * here produces a message that says what to configure.
 */
export function configuredCategoryFor(
  account: MarketplaceAccountRow,
  product: ProductRow,
  categoryIdOverride: string | null,
): string | null {
  if (categoryIdOverride) return categoryIdOverride;

  const settings = account.sync_settings ?? {};
  const rawMap = settings['reverb_category_map'];

  if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap) && product.category) {
    const map = rawMap as Record<string, unknown>;
    const wanted = normalise(product.category);

    for (const [shopifyType, reverbCategory] of Object.entries(map)) {
      if (normalise(shopifyType) !== wanted) continue;
      if (typeof reverbCategory === 'string' && reverbCategory.trim() !== '') {
        return reverbCategory;
      }
    }
  }

  const fallback = settings['reverb_default_category'];
  if (typeof fallback === 'string' && fallback.trim() !== '') return fallback;

  return null;
}
