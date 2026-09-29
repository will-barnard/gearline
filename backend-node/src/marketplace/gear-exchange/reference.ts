import type { MarketplaceAccountRow, ProductRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { PermanentMarketplaceError } from '../types.js';
import * as client from './client.js';
import type { GxOption } from './types.js';

const log = loggerFor('gx-reference');

/**
 * Condition and category lookups, cached.
 *
 * Both catalogues are global rather than per seller, so one process-wide cache
 * serves every account. Same policy as the Reverb condition cache: refresh on a
 * TTL, refresh early on a miss (so something GX adds later resolves without a
 * deploy), and never throw away a usable cache because a refresh failed.
 *
 * Unlike Reverb there is no hard-coded fallback table — the docs publish no
 * IDs, and a guessed ID is worse than a clear "could not load conditions"
 * error, because a wrong condition goes live silently.
 */

const TTL_MS = 60 * 60 * 1000;

interface Cache {
  options: GxOption[];
  fetchedAt: number;
}

const caches = new Map<'conditions' | 'categories', Cache>();

/** Test seam. */
export function resetReferenceCache(): void {
  caches.clear();
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function load(
  account: MarketplaceAccountRow,
  kind: 'conditions' | 'categories',
  force: boolean,
): Promise<GxOption[]> {
  const cached = caches.get(kind);
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.options;

  try {
    const options =
      kind === 'conditions' ? await client.getConditions(account) : await client.getCategories(account);

    if (options.length > 0) {
      caches.set(kind, { options, fetchedAt: Date.now() });
      return options;
    }

    log.warn({ kind }, 'Gear Exchange returned an empty list');
  } catch (err) {
    if (!cached) throw err;
    log.warn({ err, kind }, 'Gear Exchange reference refresh failed — using cached copy');
  }

  return cached?.options ?? [];
}

/** Finds an option by id, or by name case-insensitively. */
function find(options: GxOption[], idOrName: string): GxOption | undefined {
  const wanted = normalise(idOrName);
  return options.find((o) => o.id === idOrName.trim()) ?? options.find((o) => normalise(o.name) === wanted);
}

async function resolve(
  account: MarketplaceAccountRow,
  kind: 'conditions' | 'categories',
  idOrName: string,
): Promise<GxOption | undefined> {
  const hit = find(await load(account, kind, false), idOrName);
  if (hit) return hit;
  // A miss may just be a stale cache — refresh once before giving up.
  return find(await load(account, kind, true), idOrName);
}

/**
 * Resolves a condition name ("Mint") or ID to the ID GX wants.
 *
 * `conditionMapping` (the listing's condition_mapping override) wins over the
 * mapped product condition, and may be either a name or an ID.
 */
export async function resolveConditionId(
  account: MarketplaceAccountRow,
  nameOrId: string,
): Promise<string> {
  const hit = await resolve(account, 'conditions', nameOrId);

  if (!hit) {
    const known = (caches.get('conditions')?.options ?? []).map((o) => o.name).join(', ');
    throw new PermanentMarketplaceError(
      `Gear Exchange has no condition "${nameOrId}"` + (known ? ` (it offers: ${known})` : '') + '.',
    );
  }

  return hit.id;
}

/**
 * Which category a product should publish under, before resolution:
 *
 *   1. category_id override on the listing
 *   2. gx_category_map[product type] on the account
 *   3. gx_default_category on the account
 *
 * The same shape as Reverb's product-type mapping, deliberately, so the two
 * settings screens behave the same.
 */
export function configuredCategoryFor(
  account: Pick<MarketplaceAccountRow, 'sync_settings'>,
  product: Pick<ProductRow, 'category'>,
  overrideCategoryId: string | null,
): string | null {
  if (overrideCategoryId && overrideCategoryId.trim() !== '') return overrideCategoryId.trim();

  const settings = account.sync_settings ?? {};
  const map = settings['gx_category_map'];

  if (product.category && map && typeof map === 'object' && !Array.isArray(map)) {
    const wanted = normalise(product.category);
    for (const [type, category] of Object.entries(map as Record<string, unknown>)) {
      if (normalise(type) === wanted && typeof category === 'string' && category.trim() !== '') {
        return category.trim();
      }
    }
  }

  const fallback = settings['gx_default_category'];
  return typeof fallback === 'string' && fallback.trim() !== '' ? fallback.trim() : null;
}

/**
 * Resolves a configured category (ID or name) to a GX category ID.
 *
 * A purely numeric value is trusted as an ID without a lookup — that is what
 * the settings dropdown stores, and it keeps a publish working when the
 * category endpoint is briefly down.
 */
export async function resolveCategoryId(
  account: MarketplaceAccountRow,
  configured: string,
): Promise<string> {
  if (/^\d+$/.test(configured)) return configured;

  const hit = await resolve(account, 'categories', configured);
  if (!hit) {
    throw new PermanentMarketplaceError(
      `Gear Exchange has no category "${configured}". Re-select it in the Gear Exchange account settings.`,
    );
  }
  return hit.id;
}
