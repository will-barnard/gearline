import { db } from '../../db/index.js';
import { toJson } from '../../db/json.js';
import type {
  ListingStatus,
  MarketplaceAccountRow,
  ProductCondition,
  ProductRow,
} from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import { notifyMarketplace } from '../../services/fulfillment-notification.js';
import { propagateInventoryChange } from '../../services/inventory-consistency.js';
import { enqueue } from '../../queue/sync-job-producer.js';
import { divideHalfUp, decimalToString } from '../../util/decimal.js';
import * as client from './client.js';

const log = loggerFor('shopify-webhook-processor');

/**
 * Processes Shopify webhook payloads. Port of ShopifyWebhookProcessor.
 *
 * All handlers are idempotent — Shopify delivers at-least-once and retries any
 * webhook it does not get a 2xx for within 5 seconds.
 *
 * ── The manual publish gate ──────────────────────────────────────────────────
 *
 * Publishing to a marketplace is deliberately NOT automatic. On a product
 * create/update Gearline upserts the Product and creates listing rows in
 * NEEDS_REVIEW; a human then reviews overrides and clicks Publish. Nothing here
 * should ever enqueue LISTING_PUBLISH.
 *
 * What IS automatic:
 *   inventory_levels/update → immediate cross-channel propagation (delist at 0)
 *   products/update         → LISTING_UPDATE for listings that are already ACTIVE
 *   orders/create           → order import
 *   fulfillments/create     → tracking forwarded to the origin marketplace
 */

type Json = Record<string, unknown>;

// ── JSON path helpers ────────────────────────────────────────────────────────
// Shopify payloads are deeply optional. Jackson's `.path(x).asText("")` never
// threw; these reproduce that tolerance rather than littering every access with
// optional chaining and casts.

function str(node: unknown, key: string, fallback = ''): string {
  if (typeof node !== 'object' || node === null) return fallback;
  const value = (node as Json)[key];
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function num(node: unknown, key: string, fallback: number): number {
  if (typeof node !== 'object' || node === null) return fallback;
  const value = (node as Json)[key];
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function obj(node: unknown, key: string): Json | null {
  if (typeof node !== 'object' || node === null) return null;
  const value = (node as Json)[key];
  return typeof value === 'object' && value !== null ? (value as Json) : null;
}

function arr(node: unknown, key: string): unknown[] {
  if (typeof node !== 'object' || node === null) return [];
  const value = (node as Json)[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Every variant on the payload.
 *
 * Shopify always sends at least one — a product with no options still has a
 * single variant titled "Default Title" — so an empty result means a malformed
 * payload, not a product without variants.
 */
function variantsOf(payload: Json): Json[] {
  return arr(payload, 'variants').filter(
    (v): v is Json => typeof v === 'object' && v !== null,
  );
}

/**
 * Shopify's placeholder title for the implicit variant of a product with no
 * options. Appending it to titles would put "— Default Title" on every
 * single-variant product in the catalogue.
 */
const DEFAULT_VARIANT_TITLE = 'Default Title';

/**
 * What this row is called: the variant's own name.
 *
 * Not the product title, and not the two concatenated. Concatenating produced
 * titles like "Rhodes Peterson Cable (4-Pin) — Peterson 4-Pin Square
 * (1970–1973)", where sibling rows share their first 29 characters and only
 * diverge at the tail — so in a table, or truncated in a listing picker, the two
 * variants are indistinguishable at a glance. The variant name is the part that
 * identifies the item, so it is the whole name.
 *
 * products.title is also the Reverb listing title, and the same reasoning holds
 * there: the listing should be called what the variant is. Reverb carries
 * "Rhodes" separately in `make`.
 *
 * A product with no options still has one variant, titled "Default Title" —
 * Shopify's placeholder, never a real name. Those keep the product title, which
 * is every one-off instrument in the catalogue.
 */
function variantTitle(productTitle: string, variant: Json): string {
  const name = str(variant, 'title').trim();

  if (name === '' || name === DEFAULT_VARIANT_TITLE) return productTitle;

  return name;
}

/**
 * SKU for a variant, falling back to a placeholder the operator can replace.
 *
 * The variant id is part of the placeholder because `sku` is NOT NULL UNIQUE:
 * two SKU-less variants of one product would otherwise collide on
 * `SHOPIFY-{productId}` and the whole product would fail to import.
 */
function variantSku(shopifyProductId: string, variant: Json): string {
  const sku = str(variant, 'sku').trim();
  if (sku !== '') return sku;

  return `SHOPIFY-${shopifyProductId}-${str(variant, 'id')}`;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Dispatches a webhook to its handler.
 *
 * Never throws: the HTTP layer has already returned 200 to Shopify by the time
 * this runs. Letting an error escape here would become an unhandled rejection
 * and take the process down (see the handler in index.ts).
 */
export async function process(topic: string, shopDomain: string, rawBody: Buffer): Promise<void> {
  try {
    const payload = JSON.parse(rawBody.toString('utf8')) as Json;

    switch (topic) {
      case 'inventory_levels/update':
        await processInventoryLevelUpdate(shopDomain, payload);
        break;
      case 'products/create':
        await processProductCreate(shopDomain, payload);
        break;
      case 'products/update':
        await processProductUpdate(shopDomain, payload);
        break;
      case 'orders/create':
        await processOrderCreate(shopDomain, payload);
        break;
      case 'fulfillments/create':
        await processFulfillmentCreate(shopDomain, payload);
        break;
      default:
        log.debug({ topic }, 'Unhandled Shopify webhook topic');
    }
  } catch (err) {
    log.error({ err, topic, shopDomain }, 'Error processing Shopify webhook');
  }
}

// ── inventory_levels/update ──────────────────────────────────────────────────

/**
 * Propagates a Shopify inventory change to every other channel.
 *
 * ── Idempotency via a marker row ─────────────────────────────────────────────
 *
 * Inventory updates are processed inline, not through the job queue, so there
 * is no natural job row to dedupe against. A COMPLETED marker row is written
 * purely to occupy the idempotency key.
 *
 * The key includes Shopify's `updated_at`, so a genuine subsequent change
 * produces a new key while a redelivery of the same event does not.
 *
 * The insert is the dedup mechanism, not the preceding check: ON CONFLICT DO
 * NOTHING is atomic, whereas check-then-insert has a race that Shopify's retry
 * storms will find.
 */
async function processInventoryLevelUpdate(shopDomain: string, payload: Json): Promise<void> {
  const inventoryItemId = str(payload, 'inventory_item_id');
  const available = num(payload, 'available', 0);
  const updatedAt = str(payload, 'updated_at');

  log.info({ inventoryItemId, available, shopDomain }, 'Shopify inventory_levels/update');

  if (inventoryItemId === '') {
    log.warn({ shopDomain }, 'Inventory webhook has no inventory_item_id — skipping');
    return;
  }

  const idempotencyKey = `shopify-inv-${inventoryItemId}-${updatedAt}`;

  const marker = await db
    .insertInto('sync_jobs')
    .values({
      job_type: 'INVENTORY_SYNC',
      status: 'COMPLETED',
      marketplace_type: 'SHOPIFY',
      payload: toJson({ inventoryItemId }),
      idempotency_key: idempotencyKey,
      completed_at: new Date(),
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!marker) {
    log.debug({ inventoryItemId }, 'Skipping duplicate inventory webhook');
    return;
  }

  const product = await db
    .selectFrom('products')
    .select('id')
    .where('shopify_inventory_item_id', '=', inventoryItemId)
    .executeTakeFirst();

  if (!product) {
    log.debug({ inventoryItemId }, 'No product matches this Shopify inventory item — skipping');
    return;
  }

  await propagateInventoryChange(product.id, Math.max(0, available));
}

// ── products/create ──────────────────────────────────────────────────────────

async function processProductCreate(shopDomain: string, payload: Json): Promise<void> {
  const shopifyProductId = str(payload, 'id');

  log.info({ shopifyProductId, shopDomain }, 'Shopify products/create');

  if (shopifyProductId === '') {
    log.warn({ shopDomain }, 'Product webhook has no id — skipping');
    return;
  }

  const saved = await upsertVariantsFromPayload(shopDomain, shopifyProductId, payload, {
    restoreArchived: true,
  });

  if (saved.length === 0) return;

  // Tag exclusion is a property of the Shopify product, so it is evaluated once
  // and applies to all of its variants.
  const tagExcluded = await isExcludedByTags(payload, shopDomain);

  for (const product of saved) {
    /**
     * marketplace_excluded is authoritative and immune to Shopify updates. A user
     * set it deliberately (deposit listings, restoration placeholders); nothing
     * arriving from Shopify may clear it or create listings against it.
     *
     * It is per ROW, so one variant can be excluded while its siblings list.
     */
    if (product.marketplace_excluded) {
      log.info({ sku: product.sku }, 'Product skipped for listings — marketplace_excluded=true');
      continue;
    }

    if (tagExcluded) {
      // Cancel NEEDS_REVIEW stubs that predate the tag being applied.
      const cancelled = await db
        .updateTable('marketplace_listings')
        .set({ listing_status: 'INACTIVE', updated_at: new Date() })
        .where('product_id', '=', product.id)
        .where('listing_status', '=', 'NEEDS_REVIEW')
        .returning('id')
        .execute();

      if (cancelled.length > 0) {
        log.info({ sku: product.sku, count: cancelled.length }, 'Cancelled NEEDS_REVIEW listings for tag-excluded product');
      }

      log.info({ sku: product.sku }, 'Product not queued for listings — matches an excluded tag');
      continue;
    }

    await upsertReviewListings(product);
  }
}

// ── products/update ──────────────────────────────────────────────────────────

async function processProductUpdate(shopDomain: string, payload: Json): Promise<void> {
  const shopifyProductId = str(payload, 'id');
  const shopifyStatus = str(payload, 'status', 'active');

  log.info({ shopifyProductId, shopifyStatus, shopDomain }, 'Shopify products/update');

  if (shopifyProductId === '') return;

  const existingRows = await db
    .selectFrom('products')
    .selectAll()
    .where('shopify_product_id', '=', shopifyProductId)
    .execute();

  /**
   * Not in Gearline yet but now active → route through the create path.
   *
   * This covers the draft→active transition. The initial sync filters
   * status=active, so a product that was a draft at connect time was never
   * imported. When it later goes active Shopify sends products/UPDATE, not
   * create — so without this fallthrough the product is silently lost forever.
   */
  if (existingRows.length === 0) {
    if (shopifyStatus === 'active') {
      log.info({ shopifyProductId }, 'Product not in Gearline but now active — importing via create path');
      await processProductCreate(shopDomain, payload);
    }
    return;
  }

  // ── Draft or archived in Shopify → archive here and delist everywhere ──────
  if (shopifyStatus === 'draft' || shopifyStatus === 'archived') {
    for (const row of existingRows) {
      await archiveAndDelist(row, shopifyProductId, shopifyStatus, payload);
    }
    return;
  }

  // ── Active ─────────────────────────────────────────────────────────────────

  // Which rows were archived BEFORE this upsert restores them.
  const wasArchived = new Set(
    existingRows.filter((row) => row.status === 'ARCHIVED').map((row) => row.id),
  );

  const saved = await upsertVariantsFromPayload(shopDomain, shopifyProductId, payload, {
    restoreArchived: true,
    existing: existingRows,
  });

  if (saved.length === 0) return;

  // A variant removed in Shopify leaves a row behind. Do this AFTER the upsert
  // so a variant being renamed or re-ordered is never mistaken for a deletion.
  await archiveMissingVariants(shopifyProductId, payload, existingRows);

  const tagExcluded = await isExcludedByTags(payload, shopDomain);
  const updatedAt = str(payload, 'updated_at', String(Date.now()));

  for (const product of saved) {
    if (wasArchived.has(product.id)) {
      /**
       * Just restored. Its old listings were delisted when it was archived, so
       * there is nothing ACTIVE to send LISTING_UPDATE to — instead the listings
       * go back to NEEDS_REVIEW for the operator to re-publish.
       */
      if (product.marketplace_excluded) {
        log.info({ sku: product.sku }, 'Restored product not queued — marketplace_excluded=true');
        continue;
      }

      if (tagExcluded) {
        log.info({ sku: product.sku }, 'Restored product not queued — matches an excluded tag');
        continue;
      }

      await upsertReviewListings(product);
      continue;
    }

    // Safety net: excluded products should have no ACTIVE listings, but if one
    // survived (excluded after publishing), do not propagate updates to it.
    if (product.marketplace_excluded) {
      log.debug({ sku: product.sku }, 'Skipping LISTING_UPDATE propagation — marketplace_excluded');
      continue;
    }

    /**
     * Push changes to listings that are already live. Shopify is the source of
     * truth, so a price or title change there should cascade without review.
     *
     * NEEDS_REVIEW / PENDING / FAILED listings are left alone — they pick up
     * current product data when they are eventually published.
     */
    const activeListings = await db
      .selectFrom('marketplace_listings')
      .selectAll()
      .where('product_id', '=', product.id)
      .where('listing_status', '=', 'ACTIVE')
      .execute();

    for (const listing of activeListings) {
      if (listing.marketplace_type === 'SHOPIFY') continue;

      await enqueue({
        jobType: 'LISTING_UPDATE',
        marketplaceType: listing.marketplace_type,
        marketplaceAccountId: listing.marketplace_account_id,
        productId: product.id,
        listingId: listing.id,
        payload: { shopifyProductId },
        idempotencyKey: `shopify-product-update-${shopifyProductId}-listing-${listing.id}-${updatedAt}`,
      });

      log.info(
        { marketplace: listing.marketplace_type, listingId: listing.id },
        'Enqueued LISTING_UPDATE after Shopify product update',
      );
    }
  }
}

async function archiveAndDelist(
  product: ProductRow,
  shopifyProductId: string,
  shopifyStatus: string,
  payload: Json,
): Promise<void> {
  if (product.status !== 'ARCHIVED') {
    await db
      .updateTable('products')
      .set({ status: 'ARCHIVED', updated_at: new Date() })
      .where('id', '=', product.id)
      .execute();

    log.info({ sku: product.sku, shopifyStatus }, 'Archived product — Shopify status changed');
  }

  const activeListings = await db
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('product_id', '=', product.id)
    .where('listing_status', '=', 'ACTIVE')
    .execute();

  const updatedAt = str(payload, 'updated_at', String(Date.now()));

  for (const listing of activeListings) {
    if (listing.marketplace_type === 'SHOPIFY') continue;

    await enqueue({
      jobType: 'LISTING_DELIST',
      marketplaceType: listing.marketplace_type,
      marketplaceAccountId: listing.marketplace_account_id,
      productId: product.id,
      listingId: listing.id,
      payload: { shopifyProductId, reason: shopifyStatus },
      idempotencyKey: `shopify-product-delist-${shopifyProductId}-listing-${listing.id}-${updatedAt}`,
    });

    log.info(
      { marketplace: listing.marketplace_type, listingId: listing.id, shopifyStatus },
      'Enqueued LISTING_DELIST — Shopify product went inactive',
    );
  }
}

// ── orders/create ────────────────────────────────────────────────────────────

async function processOrderCreate(shopDomain: string, payload: Json): Promise<void> {
  const orderId = str(payload, 'id');

  log.info({ orderId, shopDomain }, 'Shopify orders/create');

  if (orderId === '') return;

  const account = await db
    .selectFrom('marketplace_accounts')
    .select('id')
    .where('marketplace_type', '=', 'SHOPIFY')
    .where('active', '=', true)
    .orderBy('created_at', 'asc')
    .executeTakeFirst();

  if (!account) {
    log.warn({ orderId }, 'No active Shopify account — cannot import order');
    return;
  }

  await enqueue({
    jobType: 'ORDER_IMPORT',
    marketplaceType: 'SHOPIFY',
    marketplaceAccountId: account.id,
    payload: { externalOrderId: orderId },
    idempotencyKey: `shopify-order-create-${orderId}`,
  });
}

// ── fulfillments/create ──────────────────────────────────────────────────────

/**
 * Forwards tracking info back to the marketplace the order originated from.
 *
 * Both Reverb and eBay are wired. On failure the notification service saves the
 * tracking data but leaves the order UNSHIPPED, so a marketplace that was never
 * actually told is visible rather than silently marked complete.
 */
async function processFulfillmentCreate(shopDomain: string, payload: Json): Promise<void> {
  const shopifyOrderId = str(payload, 'order_id');
  const trackingNumber = str(payload, 'tracking_number') || null;
  const trackingCarrier = str(payload, 'tracking_company') || null;

  // Prefer the first entry of tracking_urls; fall back to the singular field.
  const urls = arr(payload, 'tracking_urls');
  const trackingUrl =
    (urls.length > 0 && typeof urls[0] === 'string' ? (urls[0] as string) : null) ??
    (str(payload, 'tracking_url') || null);

  /**
   * The real ship date from the payload, not the processing time. Defaulting to
   * now() here would silently misreport fulfilment dates whenever a webhook was
   * delayed or replayed.
   */
  let fulfilledAt: Date | null = null;
  const createdAtStr = str(payload, 'created_at');

  if (createdAtStr !== '') {
    const parsed = new Date(createdAtStr);
    if (Number.isNaN(parsed.getTime())) {
      log.warn({ createdAtStr }, 'Could not parse fulfillment created_at');
    } else {
      fulfilledAt = parsed;
    }
  }

  log.info(
    { shopifyOrderId, trackingCarrier, trackingNumber, fulfilledAt, shopDomain },
    'Shopify fulfillments/create',
  );

  // The notification service owns all order-status transitions from here —
  // notably it will NOT mark SHIPPED if the marketplace call fails.
  await notifyMarketplace({
    shopifyOrderId,
    trackingNumber,
    trackingCarrier,
    trackingUrl,
    fulfilledAt,
  });
}

// ── Product upsert ───────────────────────────────────────────────────────────

/**
 * Creates or updates ONE products row per Shopify variant, then applies
 * metafields to all of them.
 *
 * ── Why per variant ──────────────────────────────────────────────────────────
 *
 * Marketplaces sell variants, not products: a cable in two connector types is
 * two Reverb listings with two SKUs, two prices and two stock counts. This used
 * to read variants[0] and drop the rest, so the second variant had no row and
 * its stock changes went nowhere — inventory_levels/update matches on
 * shopify_inventory_item_id, which is per-variant.
 *
 * ── Identity ─────────────────────────────────────────────────────────────────
 *
 * Rows are matched on shopify_variant_id, guarded by uq_products_shopify_variant
 * (V18). SKU is no longer an identity: two variants can both be SKU-less, and
 * the operator may change a SKU at any time, but a variant id is stable for the
 * life of the variant.
 *
 * The insert still carries ON CONFLICT on sku so two webhooks racing for the
 * same new variant cannot both insert.
 *
 * Returns every row it touched, in payload order.
 */
async function upsertVariantsFromPayload(
  shopDomain: string,
  shopifyProductId: string,
  payload: Json,
  opts: { restoreArchived: boolean; existing?: ProductRow[] },
): Promise<ProductRow[]> {
  const variants = variantsOf(payload);

  if (variants.length === 0) {
    log.warn({ shopifyProductId }, 'Shopify product payload has no variants — skipping');
    return [];
  }

  const existingRows =
    opts.existing ??
    (await db
      .selectFrom('products')
      .selectAll()
      .where('shopify_product_id', '=', shopifyProductId)
      .execute());

  const byVariantId = new Map<string, ProductRow>();
  for (const row of existingRows) {
    if (row.shopify_variant_id) byVariantId.set(row.shopify_variant_id, row);
  }

  /**
   * Rows imported before V18 that never recorded a variant id. There is at most
   * one per product (ingestion only ever created one), and it is variant 1 —
   * so it is claimed by the first variant rather than orphaned, which keeps its
   * id, its SKU and any live listing attached to it.
   */
  const unkeyed = existingRows.filter((row) => !row.shopify_variant_id);

  const productTitle = str(payload, 'title', 'Untitled Product');
  const saved: ProductRow[] = [];

  for (const [index, variant] of variants.entries()) {
    const variantId = str(variant, 'id');

    if (variantId === '' || variantId === 'null') {
      log.warn({ shopifyProductId }, 'Shopify variant has no id — skipping');
      continue;
    }

    const existing = byVariantId.get(variantId) ?? (index === 0 ? unkeyed[0] : undefined);
    const fields = extractVariantFields(payload, variant, productTitle);

    let row: ProductRow | undefined;

    if (existing) {
      const patch: Record<string, unknown> = { ...fields, updated_at: new Date() };

      /**
       * Products arriving on these paths are active by definition. Restoring the
       * status here re-activates something that was archived while it was a
       * draft.
       */
      if (opts.restoreArchived && existing.status === 'ARCHIVED') {
        patch['status'] = 'ACTIVE';
        log.info({ sku: existing.sku }, 'Restored archived product to ACTIVE during sync');
      }

      row = await db
        .updateTable('products')
        .set(patch)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirst();
    } else {
      row = await db
        .insertInto('products')
        .values({
          sku: fields.sku ?? variantSku(shopifyProductId, variant),
          title: fields.title ?? productTitle,
          price: fields.price ?? '0',
          quantity: fields.quantity ?? 0,
          condition: 'USED', // sensible default; metafields or the user may override
          status: 'ACTIVE',
          shopify_product_id: shopifyProductId,
          shopify_variant_id: variantId,
          shopify_inventory_item_id: fields.shopify_inventory_item_id ?? null,
          image_urls: toJson(fields.image_urls ?? []),
          description: fields.description ?? null,
          brand: fields.brand ?? null,
          category: fields.category ?? null,
          weight_kg: fields.weight_kg ?? null,
        })
        /**
         * ── The guard on this conflict clause is load-bearing ────────────────
         *
         * An unguarded DO UPDATE here is what corrupted rows before V18: when a
         * NEW Shopify product first arrived carrying a SKU an existing row
         * already held — a duplicated product, or a SKU typed before being
         * corrected — the insert did not create a row. It overwrote a different
         * product's row with this product's title, price and (until V18) variant
         * id, while leaving its shopify_product_id pointing elsewhere.
         *
         * Restricting the update to the SAME Shopify product keeps what the
         * clause is actually for — two webhooks racing to create one variant —
         * and makes a cross-product SKU collision do nothing instead. The
         * caller then sees no row and logs it, so a collision is a visible
         * error rather than silent, undetectable damage to an unrelated
         * product.
         */
        .onConflict((oc) =>
          oc
            .column('sku')
            .doUpdateSet({ ...fields, updated_at: new Date() })
            .where('products.shopify_product_id', '=', shopifyProductId),
        )
        .returningAll()
        .executeTakeFirst();
    }

    if (!row) {
      /**
       * Almost always the guarded conflict above declining a cross-product SKU
       * collision. Naming the SKU makes it fixable: the operator changes it in
       * Shopify and the next webhook creates the row properly.
       */
      log.error(
        { shopifyProductId, variantId, sku: fields.sku },
        'Could not upsert product row — its SKU is already held by a different Shopify product',
      );
      continue;
    }

    saved.push(row);
  }

  if (saved.length === 0) return [];

  return applyMetafields(saved, shopDomain, shopifyProductId);
}

/**
 * Archives rows whose variant is no longer on the payload.
 *
 * Shopify has no variant-level delete webhook — a deleted variant simply stops
 * appearing in products/update. Leaving the row ACTIVE would keep a marketplace
 * listing live with nothing behind it, which is the failure this codebase
 * guards against everywhere else, so archiveAndDelist takes the listing down
 * with it rather than orphaning it.
 */
async function archiveMissingVariants(
  shopifyProductId: string,
  payload: Json,
  existingRows: ProductRow[],
): Promise<void> {
  const present = new Set(
    variantsOf(payload)
      .map((v) => str(v, 'id'))
      .filter((id) => id !== '' && id !== 'null'),
  );

  if (present.size === 0) return; // malformed payload — archive nothing

  for (const row of existingRows) {
    // Rows with no variant id predate V18 and are claimed by variant 1; rows
    // already archived need no second delist.
    if (!row.shopify_variant_id) continue;
    if (present.has(row.shopify_variant_id)) continue;
    if (row.status === 'ARCHIVED') continue;

    log.info(
      { sku: row.sku, variantId: row.shopify_variant_id },
      'Variant no longer exists in Shopify — archiving and delisting',
    );

    await archiveAndDelist(row, shopifyProductId, 'variant-removed', payload);
  }
}

/**
 * Fields this webhook can update on a product.
 *
 * Explicitly typed rather than `Record<string, unknown>` — an untyped bag means
 * every read of `fields.price` widens to `{}`, and the compiler stops checking
 * that what we write matches the column. Optional throughout, because "absent"
 * and "set to null" are different: an absent field must leave the existing
 * value alone.
 */
interface ProductFieldPatch {
  title?: string;
  description?: string;
  brand?: string;
  category?: string;
  sku?: string;
  price?: string;
  quantity?: number;
  weight_kg?: string;
  shopify_inventory_item_id?: string;
  image_urls?: ReturnType<typeof toJson>;
}

/**
 * Extracts mutable fields for ONE variant.
 *
 * Product-level fields (description, vendor, product type, images) are shared
 * by every variant of the product; the rest come from the variant itself.
 *
 * Shopify's own IDs are identity keys and are never overwritten here, except
 * for the inventory item id which Shopify can legitimately reassign.
 */
function extractVariantFields(
  payload: Json,
  variant: Json,
  productTitle: string,
): ProductFieldPatch {
  const fields: ProductFieldPatch = {};

  // ── Product level ──────────────────────────────────────────────────────────

  if (productTitle !== '') fields.title = variantTitle(productTitle, variant);

  if ('body_html' in payload) fields.description = str(payload, 'body_html');

  const vendor = str(payload, 'vendor');
  if (vendor !== '') fields.brand = vendor;

  const productType = str(payload, 'product_type');
  if (productType !== '') fields.category = productType;

  const images = arr(payload, 'images');
  if (images.length > 0) {
    const urls = images
      .map((img) => str(img, 'src'))
      .filter((src) => src !== '');

    if (urls.length > 0) fields.image_urls = toJson(urls);
  }

  // ── Variant level ──────────────────────────────────────────────────────────

  // SKU is kept in sync, which is what replaces a "SHOPIFY-{id}-{variant}"
  // placeholder once the merchant sets a real one.
  const sku = str(variant, 'sku');
  if (sku !== '') fields.sku = sku;

  const price = str(variant, 'price');
  if (price !== '' && /^-?\d+(\.\d+)?$/.test(price)) fields.price = price;

  const qty = num(variant, 'inventory_quantity', Number.NEGATIVE_INFINITY);
  if (Number.isFinite(qty)) fields.quantity = Math.max(0, qty);

  // Shopify sends grams; the column is kg at scale 3.
  const grams = num(variant, 'grams', 0);
  if (grams > 0) {
    fields.weight_kg = decimalToString(divideHalfUp(BigInt(Math.round(grams)), 1000n, 3));
  }

  const inventoryItemId = str(variant, 'inventory_item_id');
  if (inventoryItemId !== '' && inventoryItemId !== 'null') {
    fields.shopify_inventory_item_id = inventoryItemId;
  }

  return fields;
}

// ── Metafields ───────────────────────────────────────────────────────────────

/**
 * Applies Shopify metafields to the product.
 *
 * Best-effort throughout: a metafield API failure logs and returns the product
 * unchanged rather than failing the whole webhook. These carry enrichment
 * (model, year, finish, video, dimensions), not correctness-critical data.
 */
async function applyMetafields(
  products: ProductRow[],
  shopDomain: string,
  shopifyProductId: string,
): Promise<ProductRow[]> {
  const account = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('external_account_id', '=', shopDomain)
    .executeTakeFirst();

  if (!account) {
    log.debug({ shopDomain }, 'No Shopify account for this domain — skipping metafields');
    return products;
  }

  try {
    const metafields = await client.fetchProductMetafields(account, shopifyProductId);
    const patch: Record<string, unknown> = {};

    for (const mf of metafields) {
      const namespace = str(mf, 'namespace');
      const key = str(mf, 'key');
      const value = str(mf, 'value');

      if (namespace !== 'custom' || value.trim() === '') continue;

      switch (key) {
        case 'youtube_url':
          patch['video_url'] = value;
          break;
        case 'reverb_model':
          patch['model'] = value;
          break;
        case 'reverb_year':
          patch['year_made'] = value;
          break;
        case 'reverb_finish':
          patch['finish'] = value;
          break;
        case 'condition_notes':
          patch['condition_notes'] = value;
          break;
        case 'dim_length_in':
        case 'dim_width_in':
        case 'dim_height_in': {
          const trimmed = value.trim();
          if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
            patch[key] = trimmed; // column names match the metafield keys exactly
          } else {
            log.warn({ key, value, shopifyProductId }, 'Invalid dimension metafield value');
          }
          break;
        }
        case 'condition': {
          const parsed = parseCondition(value);
          if (parsed) patch['condition'] = parsed;
          else log.warn({ value, shopifyProductId }, 'Unrecognised condition metafield — keeping existing');
          break;
        }
        default:
          log.debug({ key, shopifyProductId }, 'Unhandled Shopify metafield');
      }
    }

    if (Object.keys(patch).length === 0) return products;

    /**
     * Metafields live on the Shopify PRODUCT, so they apply to every variant of
     * it. That is right for a cable sold in two connector types, and wrong when
     * two variants genuinely differ in year or finish — per-listing overrides
     * are the escape hatch for that.
     *
     * Fetched once and applied to all, rather than once per variant.
     */
    const updated = await db
      .updateTable('products')
      .set({ ...patch, updated_at: new Date() })
      .where('id', 'in', products.map((p) => p.id))
      .returningAll()
      .execute();

    log.debug(
      { shopifyProductId, keys: Object.keys(patch), rows: updated.length },
      'Applied Shopify metafields',
    );

    return updated.length > 0 ? updated : products;
  } catch (err) {
    log.warn({ err, shopifyProductId }, 'Could not apply metafields');
    return products;
  }
}

/**
 * Parses a condition metafield.
 *
 * Accepts our enum names and Reverb slugs, so sellers can type whichever is
 * natural. Returns null for anything unrecognised — the caller then KEEPS the
 * existing condition rather than defaulting, since guessing wrong misrepresents
 * an item on a live listing.
 */
export function parseCondition(raw: string): ProductCondition | null {
  if (!raw || raw.trim() === '') return null;

  const normalised = raw.trim().toUpperCase().replace(/[- ]/g, '_');

  const known: ProductCondition[] = [
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

  if ((known as string[]).includes(normalised)) return normalised as ProductCondition;

  switch (normalised) {
    case 'BRAND_NEW':
      return 'NEW';
    case 'VERY_GOOD_PLUS':
      return 'VERY_GOOD';
    case 'B_STOCK':
      return 'OPEN_BOX';
    case 'NON_FUNCTIONING':
      return 'FOR_PARTS';
    default:
      return null;
  }
}

// ── Listing helpers ──────────────────────────────────────────────────────────

/** Statuses meaning "in flight or live" — leave these alone. */
const LIVE_STATUSES: ListingStatus[] = ['ACTIVE', 'NEEDS_REVIEW', 'PENDING', 'PUBLISHING'];

/**
 * Ensures a NEEDS_REVIEW listing exists for every connected non-Shopify account.
 *
 * Rules, per account:
 *   live (ACTIVE/NEEDS_REVIEW/PENDING/PUBLISHING) → leave alone
 *   SOLD                                          → leave alone, it is history
 *   terminal (INACTIVE/DELISTED/FAILED)           → reset to NEEDS_REVIEW and
 *                                                   CLEAR the stale external ID
 *   none                                          → create one
 *
 * Clearing external_listing_id on reset matters: the old marketplace listing is
 * gone, and keeping its ID would make a later publish try to update a listing
 * that no longer exists.
 */
async function upsertReviewListings(product: ProductRow): Promise<void> {
  const accounts = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('active', '=', true)
    .where('marketplace_type', '!=', 'SHOPIFY')
    .execute();

  for (const account of accounts) {
    const existing = await db
      .selectFrom('marketplace_listings')
      .selectAll()
      .where('product_id', '=', product.id)
      .where('marketplace_account_id', '=', account.id)
      .executeTakeFirst();

    if (existing) {
      if (LIVE_STATUSES.includes(existing.listing_status) || existing.listing_status === 'SOLD') {
        continue;
      }

      await db
        .updateTable('marketplace_listings')
        .set({
          listing_status: 'NEEDS_REVIEW',
          external_listing_id: null,
          updated_at: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();

      log.info(
        { marketplace: account.marketplace_type, listingId: existing.id, sku: product.sku },
        'Reset listing to NEEDS_REVIEW',
      );
      continue;
    }

    // ON CONFLICT rather than a bare insert: two concurrent webhooks for the
    // same product both find no listing and both try to insert.
    await db
      .insertInto('marketplace_listings')
      .values({
        product_id: product.id,
        marketplace_account_id: account.id,
        marketplace_type: account.marketplace_type,
        listing_status: 'NEEDS_REVIEW',
        listing_overrides: toJson({}),
        marketplace_metadata: toJson({}),
      })
      .onConflict((oc) => oc.columns(['product_id', 'marketplace_account_id']).doNothing())
      .execute();

    log.info(
      { marketplace: account.marketplace_type, accountId: account.id, sku: product.sku },
      'Created NEEDS_REVIEW listing',
    );
  }
}

/**
 * True when the product carries a Shopify tag configured to suppress listings.
 *
 * Matching is case-insensitive and whitespace-trimmed on both sides, because
 * Shopify tags are free text and "In Store Only" vs "in-store-only" is a
 * distinction the merchant does not think they are making.
 */
async function isExcludedByTags(payload: Json, shopDomain: string): Promise<boolean> {
  const tagsStr = str(payload, 'tags');
  if (tagsStr.trim() === '') return false;

  const productTags = new Set(
    tagsStr
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ''),
  );

  if (productTags.size === 0) return false;

  const account: MarketplaceAccountRow | undefined = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('external_account_id', '=', shopDomain)
    .executeTakeFirst();

  const raw = account?.sync_settings?.['excluded_tags'];
  if (!Array.isArray(raw)) return false;

  return raw.some((t) => productTags.has(String(t).toLowerCase().trim()));
}
