import type { MarketplaceAccountRow, MarketplaceListingRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { PermanentMarketplaceError, type PublishListingRequest } from '../types.js';
import * as client from './client.js';
import { REVERB_MAX_PHOTOS } from './listing-mapper.js';

const log = loggerFor('reverb-photo-sync');

/**
 * Replacing the photos on a live Reverb listing.
 *
 * ── Why this is its own step ─────────────────────────────────────────────────
 *
 * A Reverb PUT with `photos` ADDS them; it never removes any. So ordinary
 * updates send no photos at all (listing-mapper.ts includePhotos), and a photo
 * change has to be applied by hand: add the new photos, then delete the old
 * ones by Reverb's image id. Reverb rehosts every photo, so its images cannot
 * be matched back to our URLs — the replace is always all-or-nothing.
 *
 * ── Knowing what is there ────────────────────────────────────────────────────
 *
 * The source URLs last sent are kept in the listing's metadata under
 * `photo_sources`. A replace happens when the photos we would send now differ
 * from those, and:
 *
 *   - the update was queued by a photo change or push (request.replacePhotos), or
 *   - photo_sources is recorded — Gearline put those photos there itself.
 *
 * A listing with no record and no explicit push is left alone: it was
 * published before this existed, and its photos may have been arranged by
 * hand on Reverb. The photo picker's push (or POST /listings/push-photos)
 * brings those listings in.
 *
 * ── Order of operations ──────────────────────────────────────────────────────
 *
 * New photos go up BEFORE the old ones are deleted, so a live listing is never
 * left without photos. Only when old + new would pass Reverb's 25-photo limit
 * are just enough old ones deleted first. A failure part-way leaves extra
 * photos rather than missing ones, and the retry starts from what Reverb then
 * holds: it deletes everything it finds, the earlier attempt's uploads
 * included, after adding the list again.
 */

export const PHOTO_SOURCES_KEY = 'photo_sources';

/** The photos a Reverb listing should carry: http(s) only, at most 25. */
export function reverbPhotos(imageUrls: string[]): string[] {
  return imageUrls.filter((u) => /^https?:\/\//i.test(u)).slice(0, REVERB_MAX_PHOTOS);
}

function sameList(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((u, i) => u === b[i]);
}

export function needsPhotoReplace(
  metadata: Record<string, unknown> | null | undefined,
  desired: string[],
  force: boolean,
): boolean {
  // Never strip a listing to nothing: Reverb would refuse to keep it live.
  if (desired.length === 0) return false;

  const recorded = metadata?.[PHOTO_SOURCES_KEY];
  if (sameList(recorded, desired)) return false;

  return force || Array.isArray(recorded);
}

/**
 * Which of the listing's current images to delete before the upload (only to
 * stay under the limit) and which after.
 */
export function planPhotoReplace(
  currentIds: string[],
  desiredCount: number,
): { deleteBefore: string[]; deleteAfter: string[] } {
  const overflow = Math.max(0, currentIds.length + desiredCount - REVERB_MAX_PHOTOS);
  return { deleteBefore: currentIds.slice(0, overflow), deleteAfter: currentIds.slice(overflow) };
}

async function replacePhotos(account: MarketplaceAccountRow, listingId: string, desired: string[]): Promise<void> {
  const currentIds = await client.getListingImageIds(account, listingId);
  const plan = planPhotoReplace(currentIds, desired.length);

  for (const id of plan.deleteBefore) await client.deleteListingImage(account, listingId, id);

  await client.updateListing(account, listingId, { photos: desired });

  for (const id of plan.deleteAfter) await client.deleteListingImage(account, listingId, id);

  log.info(
    { listingId, removed: currentIds.length, added: desired.length },
    'Replaced Reverb listing photos',
  );
}

/**
 * Brings a listing's photos in line after its other fields were updated.
 * Returns the metadata keys to merge onto the listing.
 *
 * A permanent failure (Reverb rejecting a photo) is recorded rather than
 * failing the update: the listing's price, stock and text did update, and
 * marking it FAILED would misreport a live, correct listing. A retryable one
 * is thrown, so the job's retry ladder re-runs the (idempotent) update.
 */
export async function syncListingPhotos(
  account: MarketplaceAccountRow,
  listingId: string,
  listing: Pick<MarketplaceListingRow, 'marketplace_metadata'>,
  request: Pick<PublishListingRequest, 'imageUrls' | 'replacePhotos'>,
): Promise<Record<string, unknown>> {
  const desired = reverbPhotos(request.imageUrls);

  if (!needsPhotoReplace(listing.marketplace_metadata, desired, request.replacePhotos === true)) return {};

  try {
    await replacePhotos(account, listingId, desired);
    return { [PHOTO_SOURCES_KEY]: desired, photo_sync_error: null };
  } catch (err) {
    if (err instanceof PermanentMarketplaceError) {
      log.error({ err, listingId }, 'Reverb rejected the photo replace');
      return { photo_sync_error: err.message.slice(0, 500) };
    }
    throw err;
  }
}
