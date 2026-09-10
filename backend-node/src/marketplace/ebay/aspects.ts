import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import type { PublishListingRequest } from '../types.js';
import * as client from './client.js';

const log = loggerFor('ebay-aspects');

/**
 * Required item specifics ("aspects") for an eBay leaf category.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * eBay checks required aspects at PUBLISH, not when the offer is created, and
 * reports them ONE AT A TIME: publish, "The item specific Number of Keys is
 * missing", add it, publish, get told the next one. For an instrument category
 * that is several round trips, each one leaving the listing unpublished.
 *
 * Checking up front turns that into a single message naming everything missing,
 * before the offer is touched.
 *
 * ── Cache ────────────────────────────────────────────────────────────────────
 *
 * Keyed by category, process-wide, on a TTL. Category aspect definitions change
 * rarely, and a publish already makes several eBay calls.
 */

const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface Entry {
  aspects: Array<{ name: string; required: boolean }>;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();

/** Test seam. */
export function resetAspectCache(): void {
  cache.clear();
}

async function load(
  account: MarketplaceAccountRow,
  categoryId: string,
): Promise<Array<{ name: string; required: boolean }>> {
  const hit = cache.get(categoryId);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.aspects;

  const aspects = await client.getItemAspectsForCategory(account, categoryId);
  cache.set(categoryId, { aspects, fetchedAt: Date.now() });

  return aspects;
}

export async function getAspects(
  account: MarketplaceAccountRow,
  categoryId: string,
): Promise<Array<{ name: string; required: boolean }>> {
  return load(account, categoryId);
}

/**
 * The item specifics set on a listing, normalised to plain strings.
 *
 * `ebay_item_specifics` is a free-form map in listing_overrides, so a value may
 * arrive as a string, a number, or an array (eBay aspects are multi-valued).
 */
function providedNames(request: PublishListingRequest): Set<string> {
  const specifics = (request.extraParams ?? {})['ebay_item_specifics'];
  const names = new Set<string>();

  if (!specifics || typeof specifics !== 'object' || Array.isArray(specifics)) return names;

  for (const [key, value] of Object.entries(specifics as Record<string, unknown>)) {
    const filled = Array.isArray(value)
      ? value.some((v) => String(v).trim() !== '')
      : String(value ?? '').trim() !== '';

    // A key present but blank is not an answer — eBay rejects it the same way
    // as a missing one, so it counts as missing here too.
    if (filled) names.add(key.trim().toLowerCase());
  }

  return names;
}

/**
 * Required aspect names this listing has not filled in.
 *
 * Returns an empty array when the lookup fails: a Taxonomy outage must not
 * block a publish that might well have succeeded. eBay remains the authority —
 * this is a better error message, not a second gatekeeper.
 */
export async function missingRequiredAspects(
  account: MarketplaceAccountRow,
  categoryId: string,
  request: PublishListingRequest,
): Promise<string[]> {
  let aspects: Array<{ name: string; required: boolean }>;

  try {
    aspects = await getAspects(account, categoryId);
  } catch (err) {
    log.warn(
      { err, categoryId },
      'Could not read required eBay aspects — letting the publish proceed',
    );
    return [];
  }

  const provided = providedNames(request);

  return aspects
    .filter((aspect) => aspect.required)
    .map((aspect) => aspect.name)
    .filter((name) => !provided.has(name.trim().toLowerCase()));
}
