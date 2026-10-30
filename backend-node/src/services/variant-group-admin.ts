import { db } from '../db/index.js';
import { toJson } from '../db/json.js';
import type { ProductRow, VariantGroupingRow } from '../db/types.js';
import { ConflictError, ResourceNotFoundError } from '../http/errors.js';
import { loggerFor } from '../logger.js';
import * as shopify from '../marketplace/shopify/client.js';
import { variantShape } from '../marketplace/shopify/variant-shape.js';
import { upsertReviewListings } from '../marketplace/shopify/webhook-processor.js';
import { enqueue } from '../queue/sync-job-producer.js';
import { channelQuantity } from './special-order.js';
import {
  byVariantOrder,
  collapsedValues,
  getGrouping,
  groupedProduct,
  planGroups,
  regroupProduct,
  type GroupConfig,
} from './variant-groups.js';

const log = loggerFor('variant-group-admin');

/**
 * The operator side of variant groups: what the grouping screen shows, and
 * what happens when it is saved. The grouping rules themselves live in
 * variant-groups.ts.
 */

export interface GroupingInput {
  /** Option names to collapse. Empty removes the grouping. */
  collapsedOptions: string[];
  leadVariantIds?: string[];
  buyerNote?: string | null;
}

async function requireShopifyProduct(productId: string): Promise<ProductRow & { shopify_product_id: string }> {
  const product = await db.selectFrom('products').selectAll().where('id', '=', productId).executeTakeFirst();
  if (!product) throw new ResourceNotFoundError('Product', productId);
  if (!product.shopify_product_id) {
    throw new ConflictError('Only products imported from Shopify can be grouped');
  }
  return product as ProductRow & { shopify_product_id: string };
}

async function productRows(shopifyProductId: string): Promise<ProductRow[]> {
  return db.selectFrom('products').selectAll().where('shopify_product_id', '=', shopifyProductId).execute();
}

/**
 * Pulls every variant's options, position and photo from Shopify. Rows
 * imported before V23 have none until their next webhook; grouping cannot
 * wait for that. Best-effort — returns false when Shopify could not be read.
 */
export async function refreshVariantShapes(shopifyProductId: string): Promise<boolean> {
  try {
    const account = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('marketplace_type', '=', 'SHOPIFY')
      .where('active', '=', true)
      .executeTakeFirst();
    if (!account) return false;

    const remote = await shopify.fetchProduct(account, shopifyProductId);
    if (!remote) return false;

    const variants = Array.isArray(remote['variants']) ? (remote['variants'] as Record<string, unknown>[]) : [];

    for (const variant of variants) {
      const variantId = String(variant['id'] ?? '');
      if (variantId === '') continue;

      const shape = variantShape(remote, variant);
      await db
        .updateTable('products')
        .set({
          variant_options: toJson(shape.variant_options),
          variant_position: shape.variant_position,
          variant_image_url: shape.variant_image_url,
        })
        .where('shopify_product_id', '=', shopifyProductId)
        .where('shopify_variant_id', '=', variantId)
        .execute();
    }

    return true;
  } catch (err) {
    log.warn({ err, shopifyProductId }, 'Could not refresh variant options from Shopify');
    return false;
  }
}

/** Option names with their values, in Shopify order, across the live variants. */
function optionCatalogue(rows: ProductRow[]): Array<{ name: string; values: string[] }> {
  const options = new Map<string, { name: string; values: string[] }>();
  for (const row of [...rows].sort(byVariantOrder)) {
    for (const o of row.variant_options ?? []) {
      const entry = options.get(o.name) ?? { name: o.name, values: [] };
      if (!entry.values.includes(o.value)) entry.values.push(o.value);
      options.set(o.name, entry);
    }
  }
  return [...options.values()];
}

/**
 * Everything the grouping screen needs: the product's options, the saved
 * grouping, and the groups it produces — each with the listing title, photos
 * and quantity it will publish with. `draft` previews an unsaved config.
 */
export async function describeGrouping(productId: string, draft?: GroupingInput) {
  const product = await requireShopifyProduct(productId);
  let rows = await productRows(product.shopify_product_id);

  let refreshed = false;
  if (rows.some((r) => r.status !== 'ARCHIVED' && (r.variant_options ?? []).length === 0)) {
    refreshed = await refreshVariantShapes(product.shopify_product_id);
    if (refreshed) rows = await productRows(product.shopify_product_id);
  }

  const live = rows.filter((r) => r.status !== 'ARCHIVED');
  const saved = await getGrouping(product.shopify_product_id);

  const config: (GroupConfig & { buyer_note: string | null }) | null = draft
    ? draft.collapsedOptions.length > 0
      ? {
          collapsed_options: draft.collapsedOptions,
          lead_variant_ids: draft.leadVariantIds ?? [],
          buyer_note: draft.buyerNote ?? null,
        }
      : null
    : saved
      ? { collapsed_options: saved.collapsed_options, lead_variant_ids: saved.lead_variant_ids, buyer_note: saved.buyer_note }
      : null;

  const byId = new Map(live.map((r) => [r.id, r]));

  const groups = config
    ? planGroups(live, config).map((g) => {
        const lead = byId.get(g.leadId)!;
        const members = g.memberIds.map((id) => byId.get(id)!).filter(Boolean);
        const grouped = groupedProduct(lead, members, rows, config);
        const prices = new Set(members.map((m) => String(m.price)));

        return {
          key: g.key,
          label: g.label,
          title: grouped.title,
          leadProductId: lead.id,
          leadVariantId: lead.shopify_variant_id,
          price: lead.price,
          priceMismatch: prices.size > 1,
          quantity: channelQuantity(grouped),
          imageUrls: grouped.image_urls,
          collapsedValues: collapsedValues(members, config.collapsed_options),
          members: members.map((m) => ({
            productId: m.id,
            variantId: m.shopify_variant_id,
            sku: m.sku,
            title: m.title,
            options: m.variant_options,
            imageUrl: m.variant_image_url,
            price: m.price,
            quantity: m.quantity,
            isLead: m.id === lead.id,
          })),
        };
      })
    : [];

  return {
    shopifyProductId: product.shopify_product_id,
    variantCount: live.length,
    options: optionCatalogue(live),
    /** Variants whose options are still unknown — they cannot be grouped yet. */
    unknownOptionCount: live.filter((r) => (r.variant_options ?? []).length === 0).length,
    refreshedFromShopify: refreshed,
    grouping: saved
      ? {
          collapsedOptions: saved.collapsed_options,
          leadVariantIds: saved.lead_variant_ids,
          buyerNote: saved.buyer_note,
          updatedAt: saved.updated_at.toISOString(),
        }
      : null,
    groups,
  };
}

/**
 * Saves (or, with no collapsed options, removes) a product's grouping and
 * applies it: members come off the marketplaces, leads get review stubs, and
 * live listings are refreshed so their titles, photos and quantities match.
 */
export async function saveGrouping(productId: string, input: GroupingInput) {
  const product = await requireShopifyProduct(productId);
  const shopifyProductId = product.shopify_product_id;

  // Options must be current before they are validated or grouped on.
  await refreshVariantShapes(shopifyProductId);

  const collapsed = [...new Set(input.collapsedOptions.map((o) => o.trim()).filter((o) => o !== ''))];

  if (collapsed.length === 0) {
    await db.deleteFrom('variant_groupings').where('shopify_product_id', '=', shopifyProductId).execute();
    log.info({ shopifyProductId }, 'Variant grouping removed');
  } else {
    const known = optionCatalogue(await productRows(shopifyProductId)).map((o) => o.name.toLowerCase());
    const unknown = collapsed.filter((c) => !known.includes(c.toLowerCase()));
    if (unknown.length > 0) {
      throw new ConflictError(`This product has no option named ${unknown.map((u) => `"${u}"`).join(', ')}`);
    }

    const values = {
      collapsed_options: collapsed,
      lead_variant_ids: [...new Set(input.leadVariantIds ?? [])],
      buyer_note: input.buyerNote && input.buyerNote.trim() !== '' ? input.buyerNote.trim() : null,
      updated_at: new Date(),
    };

    await db
      .insertInto('variant_groupings')
      .values({ shopify_product_id: shopifyProductId, ...values })
      .onConflict((oc) => oc.column('shopify_product_id').doUpdateSet(values))
      .execute();

    log.info({ shopifyProductId, collapsed }, 'Variant grouping saved');
  }

  await applyGroupingChange(shopifyProductId);
  return describeGrouping(productId);
}

/**
 * Regroups, then brings listings in line:
 *
 *   new members        taken off marketplaces (inside regroupProduct)
 *   leads              review stubs created/held/released on group quantity
 *   ungrouped rows     review stubs come back, as after an exclusion is lifted
 *   live leads and     LISTING_UPDATE, so title, photos, note and quantity
 *   ungrouped rows     reflect the change without a manual republish
 */
async function applyGroupingChange(shopifyProductId: string): Promise<void> {
  const result = await regroupProduct(shopifyProductId);
  const touched = new Set([...result.leadIds, ...result.leftGroups]);
  if (touched.size === 0) return;

  const rows = await db
    .selectFrom('products')
    .selectAll()
    .where('id', 'in', [...touched])
    .where('status', '!=', 'ARCHIVED')
    .execute();

  const stamp = Date.now();

  for (const row of rows) {
    if (!row.marketplace_excluded) await upsertReviewListings(row);

    const live = await db
      .selectFrom('marketplace_listings')
      .selectAll()
      .where('product_id', '=', row.id)
      .where('listing_status', '=', 'ACTIVE')
      .execute();

    for (const listing of live) {
      if (listing.marketplace_type === 'SHOPIFY') continue;
      await enqueue({
        jobType: 'LISTING_UPDATE',
        marketplaceType: listing.marketplace_type,
        marketplaceAccountId: listing.marketplace_account_id,
        productId: row.id,
        listingId: listing.id,
        payload: { reason: 'variant_grouping_changed' },
        idempotencyKey: `variant-group-${listing.id}-${stamp}`,
      });
    }
  }
}

export type GroupingDescription = Awaited<ReturnType<typeof describeGrouping>>;
export type { VariantGroupingRow };
