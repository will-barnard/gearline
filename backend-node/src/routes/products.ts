import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { toJson } from '../db/json.js';
import { parsePageRequest, toPage } from '../db/page.js';
import type { ProductCondition, ProductStatus } from '../db/types.js';
import { toProductDto } from '../dto/mappers.js';
import { asyncHandler, ConflictError, ResourceNotFoundError } from '../http/errors.js';
import { bulkResyncSkus, resync as resyncFromShopify } from '../marketplace/shopify/resync.js';
import { currentUser } from '../security/auth-middleware.js';
import * as audit from '../services/audit.js';
import { setExcluded, bulkSetExcluded } from '../services/product-exclusion.js';

/** Port of ProductController. Mounted at /api/v1/products. */
export const productsRouter: Router = Router();

/**
 * Whitelist from ProductController.SORTABLE_FIELDS. Anything outside it falls
 * back to createdAt. This is not cosmetic — sortBy is interpolated into an
 * ORDER BY, so an unvalidated value would be a SQL injection vector. Kysely's
 * orderBy takes a column reference, not a bound parameter, so the whitelist is
 * the only thing standing between user input and the query.
 */
const SORTABLE_COLUMNS: Record<string, string> = {
  sku: 'sku',
  title: 'title',
  brand: 'brand',
  price: 'price',
  quantity: 'quantity',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PRODUCT_STATUSES: ProductStatus[] = ['ACTIVE', 'INACTIVE', 'ARCHIVED', 'DELETED'];

const PRODUCT_CONDITIONS: ProductCondition[] = [
  'MINT',
  'EXCELLENT',
  'VERY_GOOD',
  'GOOD',
  'FAIR',
  'POOR',
  'NEW',
  'OPEN_BOX',
  'USED',
  'FOR_PARTS',
];

/** NUMERIC columns travel as strings; accept a number for API compatibility. */
const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'must be a decimal number');

const createProductSchema = z.object({
  sku: z.string().min(1, 'must not be blank').max(100),
  title: z.string().min(1, 'must not be blank').max(500),
  description: z.string().nullish(),
  brand: z.string().max(200).nullish(),
  category: z.string().max(100).nullish(),
  condition: z.enum(PRODUCT_CONDITIONS as [ProductCondition, ...ProductCondition[]]),
  price: decimalString,
  quantity: z.number().int().min(0).nullish(),
  weightKg: decimalString.nullish(),
  serialNumber: z.string().max(100).nullish(),
  imageUrls: z.array(z.string()).nullish(),
});

const updateProductSchema = z.object({
  sku: z.string().max(100).nullish(),
  title: z.string().max(500).nullish(),
  description: z.string().nullish(),
  brand: z.string().max(200).nullish(),
  category: z.string().max(100).nullish(),
  condition: z.enum(PRODUCT_CONDITIONS as [ProductCondition, ...ProductCondition[]]).nullish(),
  price: decimalString.nullish(),
  quantity: z.number().int().min(0).nullish(),
  imageUrls: z.array(z.string()).nullish(),
  videoUrl: z.string().nullish(),
});

const uuidSchema = z.string().uuid('must be a valid UUID');

// ── GET / — list with filters ────────────────────────────────────────────────

productsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, size, sortBy, sortDir } = parsePageRequest(req.query, {
      maxSize: 500,
      defaultSize: 50,
      defaultSortBy: 'createdAt',
    });

    const column = SORTABLE_COLUMNS[sortBy] ?? 'created_at';

    const status = req.query.status as ProductStatus | undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const excludedRaw = req.query.marketplaceExcluded;

    // The filters are applied to two queries (the page and its count). They are
    // written out twice rather than extracted into a generic helper, because a
    // helper generic enough to accept both Kysely builder types erases their
    // types and costs more safety than the duplication does. Both branches read
    // from the same three variables, so they cannot drift apart.
    let listQuery = db.selectFrom('products').selectAll();
    let countQuery = db.selectFrom('products').select((eb) => eb.fn.countAll<string>().as('count'));

    if (status && PRODUCT_STATUSES.includes(status)) {
      listQuery = listQuery.where('status', '=', status);
      countQuery = countQuery.where('status', '=', status);
    }

    if (excludedRaw !== undefined) {
      const excluded = String(excludedRaw) === 'true';
      listQuery = listQuery.where('marketplace_excluded', '=', excluded);
      countQuery = countQuery.where('marketplace_excluded', '=', excluded);
    }

    if (search !== '') {
      const pattern = `%${search.toLowerCase()}%`;
      // Mirrors the Java Specification: case-insensitive LIKE across
      // title, sku and brand, OR'd together.
      listQuery = listQuery.where((eb) =>
        eb.or([
          eb(eb.fn('lower', ['title']), 'like', pattern),
          eb(eb.fn('lower', ['sku']), 'like', pattern),
          eb(eb.fn('lower', ['brand']), 'like', pattern),
        ]),
      );
      countQuery = countQuery.where((eb) =>
        eb.or([
          eb(eb.fn('lower', ['title']), 'like', pattern),
          eb(eb.fn('lower', ['sku']), 'like', pattern),
          eb(eb.fn('lower', ['brand']), 'like', pattern),
        ]),
      );
    }

    const [rows, countRow] = await Promise.all([
      listQuery
        .orderBy(db.dynamic.ref(column), sortDir)
        .limit(size)
        .offset(page * size)
        .execute(),
      countQuery.executeTakeFirst(),
    ]);

    const total = Number.parseInt(countRow?.count ?? '0', 10);
    res.json(toPage(rows.map(toProductDto), total, page, size));
  }),
);

// ── GET /export.csv ──────────────────────────────────────────────────────────

/**
 * Registered BEFORE /:id. Express matches routes in declaration order, so with
 * the reverse order "export.csv" would be captured as an :id and fail UUID
 * validation. Spring's matcher preferred the literal path regardless of order,
 * which is exactly the kind of behaviour difference that survives a naive port.
 */
productsRouter.get(
  '/export.csv',
  asyncHandler(async (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="gearline-products-${today}.csv"`);

    res.write(
      'SKU,Title,Brand,Category,Model,Year,Condition,Price,Quantity,Status,MarketplaceExcluded,ShopifyProductId\n',
    );

    // Stream in pages rather than loading the whole catalogue into memory.
    // The Java version did findAll() and held every row at once; on a large
    // catalogue that is a real heap spike, and avoiding it here is free.
    const BATCH = 500;
    let offset = 0;

    for (;;) {
      const batch = await db
        .selectFrom('products')
        .selectAll()
        .orderBy('sku', 'asc')
        .limit(BATCH)
        .offset(offset)
        .execute();

      if (batch.length === 0) break;

      for (const p of batch) {
        res.write(
          [
            csvField(p.sku),
            csvField(p.title),
            csvField(p.brand),
            csvField(p.category),
            csvField(p.model),
            csvField(p.year_made),
            csvField(p.condition),
            p.price,
            String(p.quantity),
            p.status,
            String(p.marketplace_excluded),
            csvField(p.shopify_product_id),
          ].join(',') + '\n',
        );
      }

      if (batch.length < BATCH) break;
      offset += BATCH;
    }

    res.end();
  }),
);

/** Quotes a CSV field when it contains a comma, quote or newline. */
function csvField(value: string | null): string {
  if (value === null || value === undefined) return '';
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ── POST /bulk-marketplace-excluded ──────────────────────────────────────────

const bulkExcludedSchema = z.object({
  productIds: z.array(uuidSchema).nullish(),
  excluded: z.boolean(),
});

productsRouter.post(
  '/bulk-marketplace-excluded',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = bulkExcludedSchema.parse(req.body);

    if (!body.productIds || body.productIds.length === 0) {
      res.status(400).json({ error: 'productIds must not be empty' });
      return;
    }

    if (body.productIds.length > 500) {
      res.status(400).json({ error: 'Cannot update more than 500 products at once' });
      return;
    }

    const count = await bulkSetExcluded(body.productIds, body.excluded);

    audit.record({
      type: 'PRODUCT_UPDATED',
      actorId: user.id,
      entityType: 'Product',
      entityId: 'bulk',
      metadata: { marketplaceExcluded: String(body.excluded), count: String(count) },
    });

    res.json({ updated: count, excluded: body.excluded });
  }),
);

// ── GET /:id ─────────────────────────────────────────────────────────────────

productsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const product = await db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!product) throw new ResourceNotFoundError('Product', id);

    res.json(toProductDto(product));
  }),
);

// ── POST / ───────────────────────────────────────────────────────────────────

productsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = createProductSchema.parse(req.body);

    const existing = await db
      .selectFrom('products')
      .select('id')
      .where('sku', '=', body.sku)
      .executeTakeFirst();

    if (existing) {
      throw new ConflictError(`SKU already exists: ${body.sku}`);
    }

    const saved = await db
      .insertInto('products')
      .values({
        sku: body.sku,
        title: body.title,
        description: body.description ?? null,
        brand: body.brand ?? null,
        category: body.category ?? null,
        condition: body.condition,
        price: body.price,
        quantity: body.quantity ?? 0,
        weight_kg: body.weightKg ?? null,
        serial_number: body.serialNumber ?? null,
        image_urls: toJson(body.imageUrls ?? []),
        status: 'ACTIVE',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    audit.record({
      type: 'PRODUCT_CREATED',
      actorId: user.id,
      entityType: 'Product',
      entityId: saved.id,
      metadata: { sku: saved.sku },
    });

    res.status(201).location(`/api/v1/products/${saved.id}`).json(toProductDto(saved));
  }),
);

// ── PUT /:id ─────────────────────────────────────────────────────────────────

productsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = uuidSchema.parse(req.params.id);
    const body = updateProductSchema.parse(req.body);

    const product = await db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!product) throw new ResourceNotFoundError('Product', id);

    const patch: Record<string, unknown> = { updated_at: new Date() };

    // Java semantics: a null field means "leave unchanged", not "set to null".
    // Every assignment below is therefore guarded on != null, not on truthiness
    // — `quantity: 0` and `description: ""` are legitimate values that a
    // truthiness check would silently drop.
    if (body.sku != null && body.sku.trim() !== '' && body.sku !== product.sku) {
      const clash = await db
        .selectFrom('products')
        .select('id')
        .where('sku', '=', body.sku)
        .executeTakeFirst();

      if (clash) throw new ConflictError(`SKU already in use: ${body.sku}`);
      patch.sku = body.sku.trim();
    }

    if (body.title != null) patch.title = body.title;
    if (body.description != null) patch.description = body.description;
    if (body.brand != null) patch.brand = body.brand;
    if (body.category != null) patch.category = body.category;
    if (body.condition != null) patch.condition = body.condition;
    if (body.price != null) patch.price = body.price;
    if (body.quantity != null) patch.quantity = body.quantity;
    if (body.imageUrls != null) patch.image_urls = toJson(body.imageUrls);
    if (body.videoUrl != null) patch.video_url = body.videoUrl.trim() === '' ? null : body.videoUrl;

    const saved = await db
      .updateTable('products')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    audit.record({
      type: 'PRODUCT_UPDATED',
      actorId: user.id,
      entityType: 'Product',
      entityId: id,
      metadata: { sku: saved.sku },
    });

    res.json(toProductDto(saved));
  }),
);

// ── DELETE /:id — archive ────────────────────────────────────────────────────

/**
 * Soft delete: sets status ARCHIVED, never removes the row. Admin-only, enforced
 * globally by requireAdminForDelete rather than here.
 */
productsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = uuidSchema.parse(req.params.id);

    const updated = await db
      .updateTable('products')
      .set({ status: 'ARCHIVED', updated_at: new Date() })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();

    if (!updated) throw new ResourceNotFoundError('Product', id);

    audit.record({
      type: 'PRODUCT_ARCHIVED',
      actorId: user.id,
      entityType: 'Product',
      entityId: id,
    });

    res.status(204).end();
  }),
);

// ── PATCH /:id/marketplace-excluded ──────────────────────────────────────────

const excludedSchema = z.object({ excluded: z.boolean() });

productsRouter.patch(
  '/:id/marketplace-excluded',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = uuidSchema.parse(req.params.id);
    const { excluded } = excludedSchema.parse(req.body);

    const updated = await setExcluded(id, excluded);

    audit.record({
      type: 'PRODUCT_UPDATED',
      actorId: user.id,
      entityType: 'Product',
      entityId: id,
      metadata: { marketplaceExcluded: String(excluded) },
    });

    res.json(toProductDto(updated));
  }),
);

// ── Shopify resync ───────────────────────────────────────────────────────────

/**
 * Reconciles every SKU against Shopify in one atomic pass.
 *
 * Declared BEFORE /:id/resync-from-shopify so the literal path is not captured
 * as an :id.
 *
 * Returns 200 on full success, 207 when some products updated but others need
 * manual attention, and 500 when nothing could be done — matching the Java
 * status contract the frontend branches on.
 */
productsRouter.post(
  '/bulk-resync-skus-from-shopify',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await bulkResyncSkus();

    if (result.updated > 0) {
      audit.record({
        type: 'PRODUCT_UPDATED',
        actorId: user.id,
        entityType: 'Product',
        entityId: 'bulk',
        metadata: { source: 'bulk-shopify-sku-resync', updated: String(result.updated) },
      });
    }

    const status = result.success ? 200 : result.updated > 0 ? 207 : 500;
    res.status(status).json(result);
  }),
);

/**
 * Pulls one product's fields back from Shopify to correct webhook drift.
 *
 * 409 on a SKU collision — the response carries the colliding product so the UI
 * can name it and point at the bulk tool, which is the only thing that can
 * actually resolve a swap.
 */
productsRouter.post(
  '/:id/resync-from-shopify',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = uuidSchema.parse(req.params.id);

    const result = await resyncFromShopify(id);

    if (!result.success) {
      res.status(result.conflict ? 409 : 400).json({
        error: result.message,
        conflict: result.conflict,
        shopifySku: result.shopifySku ?? '',
        conflictProductId: result.conflictProductId ?? '',
        conflictProductTitle: result.conflictProductTitle ?? '',
      });
      return;
    }

    const updated = await db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!updated) throw new ResourceNotFoundError('Product', id);

    audit.record({
      type: 'PRODUCT_UPDATED',
      actorId: user.id,
      entityType: 'Product',
      entityId: id,
      metadata: {
        source: 'shopify-resync',
        skuChanged: String(result.skuChanged),
        oldSku: result.oldSku ?? '',
      },
    });

    res.json({
      product: toProductDto(updated),
      skuChanged: result.skuChanged,
      shopifySku: result.shopifySku ?? '',
      oldSku: result.oldSku ?? '',
      newSku: result.newSku ?? '',
      message: result.message,
    });
  }),
);
