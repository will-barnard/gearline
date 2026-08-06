import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { jsonMerge, toJson } from '../db/json.js';
import { parsePageRequest, toPage } from '../db/page.js';
import type { ListingStatus, ProductRow } from '../db/types.js';
import { toListingDto } from '../dto/mappers.js';
import { asyncHandler, ConflictError, ResourceNotFoundError } from '../http/errors.js';
import { enqueue } from '../queue/sync-job-producer.js';

/** Port of ListingController. Mounted at /api/v1/listings. */
export const listingsRouter: Router = Router();

const uuidSchema = z.string().uuid('must be a valid UUID');

const LISTING_STATUSES: ListingStatus[] = [
  'PENDING',
  'PUBLISHING',
  'ACTIVE',
  'INACTIVE',
  'SOLD',
  'DELISTED',
  'FAILED',
  'NEEDS_REVIEW',
];

/**
 * Batch-loads products for a page of listings, keyed by id.
 *
 * ListingDto denormalises product title/sku/price/quantity. Fetching them
 * per-listing would be a classic N+1 — 50 extra round trips per page load on
 * the busiest screen in the app. One IN query instead.
 */
async function fetchProductMap(productIds: string[]): Promise<Map<string, ProductRow>> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return new Map();

  const products = await db
    .selectFrom('products')
    .selectAll()
    .where('id', 'in', unique)
    .execute();

  return new Map(products.map((p) => [p.id, p]));
}

// ── GET / ────────────────────────────────────────────────────────────────────

listingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, size } = parsePageRequest(req.query, { maxSize: 200, defaultSize: 50 });
    const status = req.query.status as ListingStatus | undefined;
    const filterStatus = status && LISTING_STATUSES.includes(status) ? status : null;

    let listQuery = db.selectFrom('marketplace_listings').selectAll();
    let countQuery = db
      .selectFrom('marketplace_listings')
      .select((eb) => eb.fn.countAll<string>().as('count'));

    if (filterStatus) {
      listQuery = listQuery.where('listing_status', '=', filterStatus);
      countQuery = countQuery.where('listing_status', '=', filterStatus);
    }

    const [rows, countRow] = await Promise.all([
      listQuery.orderBy('created_at', 'desc').limit(size).offset(page * size).execute(),
      countQuery.executeTakeFirst(),
    ]);

    const productMap = await fetchProductMap(rows.map((l) => l.product_id));
    const total = Number.parseInt(countRow?.count ?? '0', 10);

    res.json(
      toPage(
        rows.map((l) => toListingDto(l, productMap.get(l.product_id))),
        total,
        page,
        size,
      ),
    );
  }),
);

// ── GET /product/:productId ──────────────────────────────────────────────────

/** Declared before /:id so "product" is not swallowed as an id. */
listingsRouter.get(
  '/product/:productId',
  asyncHandler(async (req, res) => {
    const productId = uuidSchema.parse(req.params.productId);

    const [listings, product] = await Promise.all([
      db.selectFrom('marketplace_listings').selectAll().where('product_id', '=', productId).execute(),
      db.selectFrom('products').selectAll().where('id', '=', productId).executeTakeFirst(),
    ]);

    res.json(listings.map((l) => toListingDto(l, product)));
  }),
);

// ── GET /:id ─────────────────────────────────────────────────────────────────

listingsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const listing = await db
      .selectFrom('marketplace_listings')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!listing) throw new ResourceNotFoundError('Listing', id);

    const product = await db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', listing.product_id)
      .executeTakeFirst();

    res.json(toListingDto(listing, product));
  }),
);

// ── POST / ───────────────────────────────────────────────────────────────────

const createListingSchema = z.object({
  productId: uuidSchema,
  marketplaceAccountId: uuidSchema,
  overrides: z.record(z.unknown()).nullish(),
});

listingsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createListingSchema.parse(req.body);

    const [product, account] = await Promise.all([
      db.selectFrom('products').selectAll().where('id', '=', body.productId).executeTakeFirst(),
      db
        .selectFrom('marketplace_accounts')
        .selectAll()
        .where('id', '=', body.marketplaceAccountId)
        .executeTakeFirst(),
    ]);

    if (!product) throw new ResourceNotFoundError('Product', body.productId);
    if (!account) throw new ResourceNotFoundError('MarketplaceAccount', body.marketplaceAccountId);

    // uq_listing_product_account enforces this at the DB level too; checking
    // here lets us return the friendly message the UI expects rather than a
    // generic integrity-violation 409.
    const existing = await db
      .selectFrom('marketplace_listings')
      .select('id')
      .where('product_id', '=', body.productId)
      .where('marketplace_account_id', '=', body.marketplaceAccountId)
      .executeTakeFirst();

    if (existing) {
      throw new ConflictError(
        'A listing already exists for this product on that marketplace account',
      );
    }

    const saved = await db
      .insertInto('marketplace_listings')
      .values({
        product_id: body.productId,
        marketplace_account_id: body.marketplaceAccountId,
        marketplace_type: account.marketplace_type,
        listing_status: 'PENDING',
        listing_overrides: toJson(body.overrides ?? {}),
        marketplace_metadata: toJson({}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    res.status(201).location(`/api/v1/listings/${saved.id}`).json(toListingDto(saved, product));
  }),
);

// ── POST /:id/publish and /:id/delist ────────────────────────────────────────

function enqueueListingJob(jobType: 'LISTING_PUBLISH' | 'LISTING_DELIST') {
  return asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const listing = await db
      .selectFrom('marketplace_listings')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!listing) throw new ResourceNotFoundError('Listing', id);

    await enqueue({
      jobType,
      marketplaceType: listing.marketplace_type,
      marketplaceAccountId: listing.marketplace_account_id,
      productId: listing.product_id,
      listingId: listing.id,
    });

    // 202 Accepted — the work happens asynchronously.
    res.status(202).end();
  });
}

listingsRouter.post('/:id/publish', enqueueListingJob('LISTING_PUBLISH'));
listingsRouter.post('/:id/delist', enqueueListingJob('LISTING_DELIST'));

// ── DELETE /:id — dismiss ────────────────────────────────────────────────────

/**
 * Dismiss sets INACTIVE without touching the marketplace.
 *
 * ACTIVE listings are refused: the item is live on eBay/Reverb, and marking it
 * inactive locally would orphan it — still for sale, no longer tracked. The
 * operator must delist first. Admin-only via requireAdminForDelete.
 */
listingsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const listing = await db
      .selectFrom('marketplace_listings')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!listing) throw new ResourceNotFoundError('Listing', id);

    if (listing.listing_status === 'ACTIVE') {
      throw new ConflictError(
        'Cannot dismiss an ACTIVE listing — delist it from the marketplace first.',
      );
    }

    await db
      .updateTable('marketplace_listings')
      .set({ listing_status: 'INACTIVE', updated_at: new Date() })
      .where('id', '=', id)
      .execute();

    res.status(204).end();
  }),
);

// ── PATCH /:id/overrides ─────────────────────────────────────────────────────

const overridesSchema = z.object({ overrides: z.record(z.unknown()).nullish() });

/**
 * Merge semantics, not replace — matches `listingOverrides.putAll(...)`.
 * The merge happens in SQL (jsonb ||) so two concurrent PATCHes setting
 * different keys cannot clobber one another.
 */
listingsRouter.patch(
  '/:id/overrides',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const { overrides } = overridesSchema.parse(req.body);

    const saved = await db
      .updateTable('marketplace_listings')
      .set({
        listing_overrides: jsonMerge('listing_overrides', overrides ?? {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!saved) throw new ResourceNotFoundError('Listing', id);

    const product = await db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', saved.product_id)
      .executeTakeFirst();

    res.json(toListingDto(saved, product));
  }),
);
