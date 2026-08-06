import { randomUUID } from 'node:crypto';

import { db } from '../../db/index.js';
import type { MarketplaceAccountRow, ProductRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import * as client from './client.js';

const log = loggerFor('shopify-resync');

/**
 * Pull-based re-sync of product fields from Shopify. Port of ShopifyResyncService.
 *
 * The normal path is push (webhooks). When a webhook fails silently — a
 * transient network error, or a unique-constraint violation swallowed by the
 * processor's catch-all — the Gearline record drifts from Shopify. This
 * corrects that on demand.
 *
 * Deliberately does NOT touch marketplace listings. It only repairs the
 * canonical product record.
 */

export interface ResyncResult {
  success: boolean;
  message: string;
  conflict: boolean;
  shopifySku: string | null;
  oldSku: string | null;
  newSku: string | null;
  skuChanged: boolean;
  conflictProductId: string | null;
  conflictProductTitle: string | null;
}

export interface BulkResyncResult {
  success: boolean;
  message: string;
  totalCompared: number;
  needingUpdate: number;
  updated: number;
  errors: string[];
}

const fail = (message: string): ResyncResult => ({
  success: false,
  message,
  conflict: false,
  shopifySku: null,
  oldSku: null,
  newSku: null,
  skuChanged: false,
  conflictProductId: null,
  conflictProductTitle: null,
});

async function activeShopifyAccount(): Promise<MarketplaceAccountRow | undefined> {
  return db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('marketplace_type', '=', 'SHOPIFY')
    .where('active', '=', true)
    .orderBy('created_at', 'asc')
    .executeTakeFirst();
}

function str(node: unknown, key: string, fallback = ''): string {
  if (typeof node !== 'object' || node === null) return fallback;
  const value = (node as Record<string, unknown>)[key];
  return value === null || value === undefined ? fallback : String(value);
}

function firstVariantSku(shopifyProduct: Record<string, unknown>): string {
  const variants = shopifyProduct['variants'];
  if (!Array.isArray(variants) || variants.length === 0) return '';
  return str(variants[0], 'sku');
}

// ── Single-product resync ────────────────────────────────────────────────────

export async function resync(productId: string): Promise<ResyncResult> {
  const product = await db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .executeTakeFirst();

  if (!product) return fail(`Product not found: ${productId}`);

  if (!product.shopify_product_id || product.shopify_product_id.trim() === '') {
    return fail(
      'This product was not imported from Shopify (no Shopify product ID) — ' +
        'update the SKU manually in the SKU Audit table.',
    );
  }

  const account = await activeShopifyAccount();
  if (!account) return fail('No active Shopify account is connected to Gearline.');

  let shopifyProduct: Record<string, unknown> | null;

  try {
    shopifyProduct = await client.fetchProduct(account, product.shopify_product_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Shopify API error: ${message}. The product may have been deleted from Shopify.`);
  }

  if (!shopifyProduct) {
    return fail(
      `Shopify returned an empty response for product ID ${product.shopify_product_id} — ` +
        'it may have been deleted.',
    );
  }

  const oldSku = product.sku;
  const shopifySku = firstVariantSku(shopifyProduct);

  /**
   * ── Pre-flight collision check ─────────────────────────────────────────────
   *
   * A collision is the single most common reason webhook SKU updates fail
   * silently: the UPDATE violates the unique constraint and the processor's
   * catch-all swallows it. Detecting it here turns an invisible failure into an
   * actionable message that points at the bulk tool, which CAN resolve it.
   */
  if (shopifySku !== '' && shopifySku !== oldSku) {
    const collider = await db
      .selectFrom('products')
      .select(['id', 'title'])
      .where('sku', '=', shopifySku)
      .where('id', '!=', productId)
      .executeTakeFirst();

    if (collider) {
      return {
        success: false,
        conflict: true,
        message:
          `Shopify has SKU "${shopifySku}" for "${product.title}", but that SKU is already ` +
          `held by "${collider.title}" in Gearline. Use "Resync all SKUs from Shopify" to fix ` +
          'all swapped SKUs at once.',
        shopifySku,
        oldSku,
        newSku: null,
        skuChanged: false,
        conflictProductId: collider.id,
        conflictProductTitle: collider.title,
      };
    }
  }

  const patch = extractResyncFields(shopifyProduct);

  // Metafields are best-effort — a failure here must not block the field repair.
  try {
    const metafields = await client.fetchProductMetafields(account, product.shopify_product_id);
    Object.assign(patch, extractMetafieldPatch(metafields));
  } catch (err) {
    log.warn(
      { err, shopifyProductId: product.shopify_product_id },
      'Could not apply metafields during re-sync',
    );
  }

  const saved = await db
    .updateTable('products')
    .set({ ...patch, updated_at: new Date() })
    .where('id', '=', productId)
    .returningAll()
    .executeTakeFirst();

  const newSku = saved?.sku ?? oldSku;

  log.info({ productId, title: product.title, oldSku, newSku }, 'Re-synced product from Shopify');

  return {
    success: true,
    conflict: false,
    message:
      newSku !== oldSku
        ? `Product re-synced. SKU changed from "${oldSku}" to "${newSku}".`
        : 'Product re-synced from Shopify.',
    shopifySku,
    oldSku,
    newSku,
    skuChanged: newSku !== oldSku,
    conflictProductId: null,
    conflictProductTitle: null,
  };
}

// ── Bulk SKU reconciliation ──────────────────────────────────────────────────

/**
 * Reconciles every SKU against Shopify, resolving swaps atomically.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 *
 * If products A and B hold each other's SKUs, NEITHER can be fixed
 * individually — each single update collides with the other. The unique
 * constraint makes any one-at-a-time approach impossible.
 *
 * ── The algorithm ──────────────────────────────────────────────────────────
 *
 *   1. Fetch shopifyProductId → SKU for every active Shopify product.
 *      HTTP happens OUTSIDE the transaction — paginating a large catalogue can
 *      take many seconds, and holding a pooled connection across it starves
 *      every other request.
 *   2. In ONE transaction:
 *      a. Work out which products need a change.
 *      b. Find "blockers" — products NOT changing that hold a SKU somebody
 *         else needs. These are usually draft/archived in Shopify, so they
 *         never appeared in the active fetch.
 *      c. Move every pending product AND every blocker to a unique
 *         RESYNC-TEMP-{uuid}. This clears the SKU space completely.
 *      d. Assign the correct SKUs.
 *
 * Step (c) is the crux: temporarily vacating every contested SKU means step (d)
 * can never collide, regardless of how tangled the permutation is.
 *
 * Running it all in one transaction means the temp state is never visible to
 * anything else — a concurrent reader sees either the old SKUs or the new ones.
 */
export async function bulkResyncSkus(): Promise<BulkResyncResult> {
  const account = await activeShopifyAccount();

  if (!account) {
    return {
      success: false,
      message: 'No active Shopify account is connected.',
      totalCompared: 0,
      needingUpdate: 0,
      updated: 0,
      errors: [],
    };
  }

  // ── Step 1: fetch from Shopify, no transaction held ────────────────────────
  const shopifySkuMap = new Map<string, string>();

  try {
    let pageInfo: string | null = null;
    let pages = 0;
    const MAX_PAGES = 1000;

    do {
      const page = await client.fetchProducts(account, pageInfo);
      pages++;

      for (const raw of page.products) {
        const p = raw as Record<string, unknown>;
        const shopifyId = str(p, 'id');
        const sku = firstVariantSku(p);

        if (shopifyId !== '' && sku !== '') shopifySkuMap.set(shopifyId, sku);
      }

      pageInfo = page.nextPageInfo;
    } while (pageInfo !== null && pages < MAX_PAGES);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Bulk SKU resync: failed to fetch products from Shopify');
    return {
      success: false,
      message: `Shopify API error: ${message}`,
      totalCompared: 0,
      needingUpdate: 0,
      updated: 0,
      errors: [],
    };
  }

  log.info({ count: shopifySkuMap.size }, 'Bulk SKU resync: fetched products from Shopify');

  // ── Step 2: reconcile, in one transaction ──────────────────────────────────
  return db.transaction().execute(async (trx) => {
    const allProducts = await trx
      .selectFrom('products')
      .select(['id', 'sku', 'title', 'shopify_product_id'])
      // Lock every row for the duration. Without this a concurrent webhook could
      // write a SKU between the temp pass and the final pass, reintroducing the
      // very collision the algorithm just cleared.
      .forUpdate()
      .execute();

    interface Pending {
      product: Pick<ProductRow, 'id' | 'sku' | 'title'>;
      correctSku: string;
      oldSku: string;
    }

    const pending: Pending[] = [];

    for (const product of allProducts) {
      if (!product.shopify_product_id) continue;

      const correctSku = shopifySkuMap.get(product.shopify_product_id);
      if (correctSku === undefined) continue; // not among active Shopify products
      if (correctSku === product.sku) continue;

      pending.push({ product, correctSku, oldSku: product.sku });
    }

    if (pending.length === 0) {
      return {
        success: true,
        message: 'All SKUs already match Shopify — nothing to update.',
        totalCompared: allProducts.length,
        needingUpdate: 0,
        updated: 0,
        errors: [],
      };
    }

    log.info({ count: pending.length }, 'Bulk SKU resync: products needing correction');

    // ── Blockers ─────────────────────────────────────────────────────────────
    const targetSkus = new Set(pending.map((p) => p.correctSku));
    const pendingIds = new Set(pending.map((p) => p.product.id));

    const blockers = allProducts.filter(
      (p) => targetSkus.has(p.sku) && !pendingIds.has(p.id),
    );

    if (blockers.length > 0) {
      log.warn(
        { count: blockers.length },
        'Bulk SKU resync: products are blocking target SKUs — moving them to temp SKUs',
      );
    }

    // ── Pass 1: vacate every contested SKU ───────────────────────────────────
    for (const item of pending) {
      await trx
        .updateTable('products')
        .set({ sku: `RESYNC-TEMP-${randomUUID()}`, updated_at: new Date() })
        .where('id', '=', item.product.id)
        .execute();
    }

    for (const blocker of blockers) {
      log.warn({ title: blocker.title, sku: blocker.sku }, 'Bulk SKU resync: blocker moved to temp SKU');
      await trx
        .updateTable('products')
        .set({ sku: `RESYNC-TEMP-${randomUUID()}`, updated_at: new Date() })
        .where('id', '=', blocker.id)
        .execute();
    }

    // ── Pass 2: assign the correct SKUs ──────────────────────────────────────
    const errors: string[] = [];
    let updated = 0;

    for (const item of pending) {
      try {
        await trx
          .updateTable('products')
          .set({ sku: item.correctSku, updated_at: new Date() })
          .where('id', '=', item.product.id)
          .execute();

        log.info(
          { title: item.product.title, from: item.oldSku, to: item.correctSku },
          'Bulk SKU resync: SKU updated',
        );
        updated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, productId: item.product.id, sku: item.correctSku }, 'Bulk SKU resync: failed');
        errors.push(`"${item.product.title}": ${message}`);
        // The product keeps its temp SKU — visible in the SKU Audit page for
        // manual correction, rather than silently reverting.
      }
    }

    /**
     * Blockers are reported as errors even though nothing went wrong.
     *
     * They have been left on temp SKUs and genuinely need human attention: the
     * SKU they held now belongs to an active Shopify product, so there is no
     * correct value to assign automatically.
     */
    for (const blocker of blockers) {
      errors.push(
        `"${blocker.title}" was moved to a temp SKU because it held a SKU needed by an ` +
          'active Shopify product. Please set its SKU manually in the SKU Audit page.',
      );
    }

    let message = `${updated} SKU${updated !== 1 ? 's' : ''} updated from Shopify`;
    if (errors.length > 0) message += `; ${errors.length} error(s)`;

    return {
      success: errors.length === 0,
      message,
      totalCompared: allProducts.length,
      needingUpdate: pending.length,
      updated,
      errors,
    };
  });
}

// ── Field extraction ─────────────────────────────────────────────────────────

/** Mutable fields pulled from a Shopify product during resync. */
function extractResyncFields(shopifyProduct: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const title = str(shopifyProduct, 'title');
  if (title !== '') patch['title'] = title;

  if ('body_html' in shopifyProduct) patch['description'] = str(shopifyProduct, 'body_html');

  const vendor = str(shopifyProduct, 'vendor');
  if (vendor !== '') patch['brand'] = vendor;

  const productType = str(shopifyProduct, 'product_type');
  if (productType !== '') patch['category'] = productType;

  const variants = shopifyProduct['variants'];
  const variant = Array.isArray(variants) && variants.length > 0 ? variants[0] : null;

  if (variant) {
    const sku = str(variant, 'sku');
    if (sku !== '') patch['sku'] = sku;

    const price = str(variant, 'price');
    if (price !== '' && /^-?\d+(\.\d+)?$/.test(price)) patch['price'] = price;

    const qtyRaw = (variant as Record<string, unknown>)['inventory_quantity'];
    if (qtyRaw !== null && qtyRaw !== undefined) {
      const qty = Number(qtyRaw);
      if (Number.isFinite(qty)) patch['quantity'] = Math.max(0, Math.trunc(qty));
    }

    const variantId = str(variant, 'id');
    if (variantId !== '' && variantId !== 'null') patch['shopify_variant_id'] = variantId;

    const inventoryItemId = str(variant, 'inventory_item_id');
    if (inventoryItemId !== '' && inventoryItemId !== 'null') {
      patch['shopify_inventory_item_id'] = inventoryItemId;
    }
  }

  return patch;
}

/** Metafield → column mapping, shared shape with the webhook processor. */
function extractMetafieldPatch(
  metafields: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const mf of metafields) {
    if (str(mf, 'namespace') !== 'custom') continue;

    const key = str(mf, 'key');
    const value = str(mf, 'value');
    if (value.trim() === '') continue;

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
      case 'dim_height_in':
        if (/^-?\d+(\.\d+)?$/.test(value.trim())) patch[key] = value.trim();
        break;
      default:
        break;
    }
  }

  return patch;
}
