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
 * The name -> uuid table is not published anywhere stable, so it is read from
 * GET /listing_conditions and cached in-process, with the verified table below
 * as a fallback. Live-first means a UUID Reverb reissues is picked up without a
 * deploy; the fallback means a Reverb outage does not block every publish.
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

/**
 * Verified against GET /listing_conditions (Accept-Version: 3.0) on
 * 2026-09-08. These eight are the COMPLETE set Reverb offers.
 *
 * The response carries only `uuid`, `display_name` and `description` — there is
 * no `slug` field, which is why matching goes through the display name.
 */
const KNOWN_CONDITIONS: ReadonlyArray<{ display_name: string; uuid: string }> = [
  { display_name: 'Brand New', uuid: '7c3f45de-2ae0-4c81-8400-fdb6b1d74890' },
  { display_name: 'Mint', uuid: 'ac5b9c1e-dc78-466d-b0b3-7cf712967a48' },
  { display_name: 'Excellent', uuid: 'df268ad1-c462-4ba6-b6db-e007e23922ea' },
  { display_name: 'Very Good', uuid: 'ae4d9114-1bd7-4ec5-a4ba-6653af5ac84d' },
  { display_name: 'Good', uuid: 'f7a3f48c-972a-44c6-b01a-0cd27488d3f6' },
  { display_name: 'Fair', uuid: '98777886-76d0-44c8-865e-bb40e669e934' },
  { display_name: 'Poor', uuid: '6a9dfcad-600b-46c8-9e08-ce6e5057921e' },
  { display_name: 'Non Functioning', uuid: 'fbf35668-96a0-4baa-bcde-ab18d6b1b329' },
];

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

/**
 * Indexes conditions by normalised display name.
 *
 * `slug` is also indexed when present. Reverb does not currently return one,
 * but indexing it costs nothing and means a future API version that adds slugs
 * keeps working without a change here.
 */
function indexConditions(
  conditions: ReadonlyArray<{ uuid?: string; slug?: string; display_name?: string }>,
): Map<string, string> {
  const bySlug = new Map<string, string>();

  for (const condition of conditions) {
    const uuid = condition.uuid;
    if (!uuid) continue;

    if (condition.slug) bySlug.set(normalise(condition.slug), uuid);
    if (condition.display_name) bySlug.set(normalise(condition.display_name), uuid);
  }

  return bySlug;
}

async function load(account: MarketplaceAccountRow): Promise<Cache> {
  const conditions = await client.getListingConditions(account);
  const bySlug = indexConditions(conditions);

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

    // No warm cache. Fall back to the verified table rather than failing a
    // publish over a Reverb blip — but do NOT cache it, so the next attempt
    // still tries the live catalogue.
    const fallback = indexConditions(KNOWN_CONDITIONS);
    const known = fallback.get(key);

    if (known) {
      log.warn(
        { err, condition: slug },
        'Could not reach Reverb listing conditions — using the verified fallback table',
      );
      return known;
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
