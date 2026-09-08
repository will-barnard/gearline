import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { PermanentMarketplaceError } from '../types.js';
import * as client from './client.js';

const log = loggerFor('reverb-conditions');

/**
 * Resolves a Reverb condition SLUG to the UUID the listings API requires.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `condition` on a listing must be `{ uuid: "..." }`. Sending the human-readable
 * `{ slug: "excellent" }` is rejected with `400 condition[uuid] is missing`.
 *
 * The slug -> uuid table is not published anywhere stable, so it is read from
 * GET /listing_conditions and cached in-process. Hardcoding the UUIDs would
 * work right up until Reverb reissued one, and then every publish would fail
 * with an error naming the condition rather than the stale table.
 *
 * ── Cache ────────────────────────────────────────────────────────────────────
 *
 * The catalogue is global, not per-seller, so one process-wide cache serves
 * every account. It is refreshed on a TTL and — more importantly — whenever a
 * lookup misses, so a condition Reverb adds later resolves on the second
 * attempt instead of needing a redeploy.
 *
 * A failed refresh does NOT clear a usable cache: a transient outage should not
 * turn every publish into a hard failure when the answer is already known.
 */

const TTL_MS = 60 * 60 * 1000; // 1 hour

interface Cache {
  bySlug: Map<string, string>;
  fetchedAt: number;
}

let cache: Cache | null = null;

/** Test seam. */
export function resetConditionCache(): void {
  cache = null;
}

/**
 * Normalises for matching: Reverb has used both "very-good" and "Very Good"
 * across fields, and display names carry capitals and spaces.
 */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

async function load(account: MarketplaceAccountRow): Promise<Cache> {
  const conditions = await client.getListingConditions(account);
  const bySlug = new Map<string, string>();

  for (const condition of conditions) {
    const uuid = condition.uuid;
    if (!uuid) continue;

    // Index under both the slug and the display name, so either form of an
    // operator-supplied condition_mapping override resolves.
    if (condition.slug) bySlug.set(normalise(condition.slug), uuid);
    if (condition.display_name) bySlug.set(normalise(condition.display_name), uuid);
  }

  if (bySlug.size === 0) {
    throw new PermanentMarketplaceError(
      'Reverb returned no usable listing conditions from GET /listing_conditions — ' +
        'cannot resolve a condition UUID for publishing.',
    );
  }

  log.info({ count: bySlug.size }, 'Loaded Reverb listing conditions');

  return { bySlug, fetchedAt: Date.now() };
}

/**
 * Returns the UUID for a condition slug, refreshing the cache on a miss.
 *
 * Throws PermanentMarketplaceError when the slug cannot be resolved. That is
 * deliberate: publishing with a wrong or absent condition either fails at
 * Reverb anyway or, worse, misrepresents the item's condition on a live
 * listing.
 */
export async function resolveConditionUuid(
  account: MarketplaceAccountRow,
  slug: string,
): Promise<string> {
  const key = normalise(slug);
  const stale = cache === null || Date.now() - cache.fetchedAt > TTL_MS;

  if (!stale) {
    const hit = cache?.bySlug.get(key);
    if (hit) return hit;
  }

  try {
    cache = await load(account);
  } catch (err) {
    // Keep serving a warm cache through a transient failure.
    const hit = cache?.bySlug.get(key);

    if (hit) {
      log.warn({ err }, 'Could not refresh Reverb listing conditions — using cached values');
      return hit;
    }

    throw err;
  }

  const uuid = cache.bySlug.get(key);

  if (!uuid) {
    const known = [...cache.bySlug.keys()].sort().join(', ');
    throw new PermanentMarketplaceError(
      `No Reverb listing condition matches "${slug}". Reverb currently offers: ${known}.`,
    );
  }

  return uuid;
}
