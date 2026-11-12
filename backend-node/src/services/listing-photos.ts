import { db } from '../db/index.js';
import { toJson } from '../db/json.js';
import type { MarketplaceType, ProductRow } from '../db/types.js';
import { ConflictError, ResourceNotFoundError } from '../http/errors.js';
import { loggerFor } from '../logger.js';
import { enqueue } from '../queue/sync-job-producer.js';
import {
  groupedProduct,
  getGrouping,
  isGroupLead,
  isGroupMember,
  MAX_LISTING_PHOTOS,
  selectedImages,
  variantImages,
} from './variant-groups.js';

const log = loggerFor('listing-photos');

/**
 * The operator side of listing photos: what the photo picker shows, saving a
 * hand-picked selection (V24), and pushing photos out to live listings.
 *
 * What a listing actually publishes is decided in variant-groups.ts
 * (listingImages / groupedProduct); this file only reads and writes the
 * choice. Order of precedence, highest first:
 *
 *   1. a per-listing image_urls override (listing_overrides)
 *   2. the selection saved here
 *   3. the automatic photos (variantImages / groupImages)
 */

async function requireProduct(id: string): Promise<ProductRow> {
  const product = await db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst();
  if (!product) throw new ResourceNotFoundError('Product', id);
  return product;
}

async function siblingsOf(product: ProductRow): Promise<ProductRow[]> {
  if (!product.shopify_product_id) return [product];
  return db
    .selectFrom('products')
    .selectAll()
    .where('shopify_product_id', '=', product.shopify_product_id)
    .execute();
}

/** What the automatic rule would publish for this row, ignoring any selection. */
async function automaticImages(product: ProductRow, siblings: ProductRow[]): Promise<string[]> {
  if (isGroupLead(product) && product.shopify_product_id) {
    const grouping = await getGrouping(product.shopify_product_id);
    if (grouping) {
      const members = siblings.filter((s) => s.variant_group_lead_id === product.id && s.status !== 'ARCHIVED');
      const unpicked = { ...product, listing_image_urls: null };
      return groupedProduct(unpicked, members, siblings, grouping).image_urls;
    }
  }
  return variantImages(product, siblings);
}

export async function describeListingPhotos(productId: string) {
  const product = await requireProduct(productId);
  const siblings = await siblingsOf(product);
  const automatic = await automaticImages(product, siblings);
  const selected = selectedImages(product);

  const overridden = await db
    .selectFrom('marketplace_listings')
    .select(['id', 'marketplace_type', 'listing_overrides'])
    .where('product_id', '=', product.id)
    .execute();

  return {
    productId: product.id,
    /** Every photo on the Shopify product, in Shopify order — what can be picked from. */
    available: product.image_urls ?? [],
    /** The photo Shopify links to this variant, if any. */
    variantImageUrl: product.variant_image_url,
    /** Other variants' linked photos — the picker marks them. */
    otherVariantImageUrls: [
      ...new Set(
        siblings
          .filter((s) => s.id !== product.id && s.variant_image_url)
          .map((s) => s.variant_image_url as string),
      ),
    ],
    mode: selected ? ('custom' as const) : ('automatic' as const),
    automatic,
    /** What the listings get now (the selection, or the automatic photos). */
    effective: selected ?? automatic,
    maxPhotos: MAX_LISTING_PHOTOS,
    isGroupLead: isGroupLead(product),
    /** Set on a group member: its photos come from the lead's listing. */
    listedThroughLeadId: isGroupMember(product) ? product.variant_group_lead_id : null,
    /** Listings whose own image override beats anything picked here. */
    listingOverrides: overridden
      .filter((l) => {
        const o = (l.listing_overrides ?? {})['image_urls'];
        return Array.isArray(o) && o.length > 0;
      })
      .map((l) => ({ listingId: l.id, marketplaceType: l.marketplace_type })),
  };
}

/**
 * Saves a selection (or, with null / [], goes back to automatic) and pushes
 * the result to this row's live listings.
 */
export async function saveListingPhotos(productId: string, imageUrls: string[] | null) {
  const product = await requireProduct(productId);

  if (isGroupMember(product)) {
    throw new ConflictError(
      "This variant is listed through its group — pick the photos on the group's lead variant instead",
    );
  }

  let value: string[] | null = null;

  if (imageUrls && imageUrls.length > 0) {
    const available = new Set(product.image_urls ?? []);
    const unknown = imageUrls.filter((u) => !available.has(u));
    if (unknown.length > 0) {
      throw new ConflictError(
        `${unknown.length} of those photos are not on this product in Shopify — reload the page and pick again`,
      );
    }
    value = [...new Set(imageUrls)];
    if (value.length > MAX_LISTING_PHOTOS) {
      throw new ConflictError(`Marketplaces take at most ${MAX_LISTING_PHOTOS} photos`);
    }
  }

  await db
    .updateTable('products')
    .set({ listing_image_urls: value === null ? null : toJson(value), updated_at: new Date() })
    .where('id', '=', product.id)
    .execute();

  log.info({ productId, mode: value ? 'custom' : 'automatic', count: value?.length ?? 0 }, 'Listing photos saved');

  const queued = await pushListingPhotos(product.id, 'listing_photos_changed');
  return { ...(await describeListingPhotos(product.id)), queued };
}

/**
 * Queues a LISTING_UPDATE that REPLACES the photos on each of the product's
 * live listings. Reverb only takes photos on create unless told to replace
 * them (reverb/photo-sync.ts), so this is also how listings published before a
 * photo change get the new photos.
 *
 * Returns the number of updates queued.
 */
export async function pushListingPhotos(
  productId: string,
  reason: string,
  marketplaceType?: MarketplaceType,
): Promise<number> {
  let query = db
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', productId)
    .where('listing_status', '=', 'ACTIVE')
    .where('marketplace_type', '!=', 'SHOPIFY');
  if (marketplaceType) query = query.where('marketplace_type', '=', marketplaceType);

  const live = await query.execute();
  const stamp = Date.now();

  for (const listing of live) {
    await enqueue({
      jobType: 'LISTING_UPDATE',
      marketplaceType: listing.marketplace_type,
      marketplaceAccountId: listing.marketplace_account_id,
      productId,
      listingId: listing.id,
      payload: { reason, replacePhotos: true },
      idempotencyKey: `listing-photos-${listing.id}-${stamp}`,
    });
  }

  return live.length;
}

/**
 * Pushes photos to every live listing on one marketplace — for bringing
 * listings published before a photo-rule change up to date in one go.
 */
export async function pushAllListingPhotos(marketplaceType: MarketplaceType): Promise<number> {
  const products = await db
    .selectFrom('marketplace_listings')
    .select('product_id')
    .distinct()
    .where('listing_status', '=', 'ACTIVE')
    .where('marketplace_type', '=', marketplaceType)
    .execute();

  let queued = 0;
  for (const { product_id } of products) {
    queued += await pushListingPhotos(product_id, 'listing_photos_bulk_push', marketplaceType);
  }

  log.info({ marketplaceType, queued }, 'Queued a photo push for every live listing');
  return queued;
}
