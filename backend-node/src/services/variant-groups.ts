import type { Kysely } from 'kysely';

import { db } from '../db/index.js';
import type { Database, ProductRow, VariantGroupingRow, VariantOptionJson } from '../db/types.js';
import { loggerFor } from '../logger.js';
import { removeFromMarketplaces } from './product-exclusion.js';
import { channelQuantity } from './special-order.js';

const log = loggerFor('variant-groups');

/**
 * Variant groups — several Shopify variants sold through ONE marketplace
 * listing.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 *
 * Gearline lists every Shopify variant on its own (one products row per
 * variant, V18). For custom Rhodes lids that come in sizes × cuts × a dozen
 * colours, that is dozens of near-identical listings. A grouping collapses one
 * or more options (Color): variants that differ ONLY in those options form a
 * group, and the group gets one listing. The buyer tells us the colour after
 * ordering.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 *
 * Each group has a LEAD — the only row that gets marketplace listings — and
 * MEMBERS, which are kept off every marketplace by checkEligibility(). Stored
 * on products.variant_group_lead_id (see V23), derived here by
 * regroupProduct() and nowhere else.
 *
 * When a lead is published, synced or updated, the connectors receive
 * groupedProduct(): the lead row with
 *
 *   title        the collapsed option removed ("… Large / Mark I")
 *   description  + the options on offer and the "message us" note
 *   image_urls   the photos picked on the lead (V24), else the lead variant's
 *                photos first, then the other members' — never the
 *                product's general shots (groupImages)
 *   quantity     the total stock across the group
 *
 * so no marketplace connector needs to know groups exist. Price, SKU, weight,
 * dimensions and condition are the lead's own: the colours are assumed to be
 * priced the same (the grouping screen warns when they are not).
 *
 * Orders arrive on the lead's SKU, so they book against the lead variant in
 * Shopify with a note to confirm the collapsed option with the buyer (see
 * shopify/order-mapper.ts).
 */

type Executor = Kysely<Database>;

export const DEFAULT_BUYER_NOTE = 'After you order, send us a message with the {options} you would like.';

// ── Row predicates ───────────────────────────────────────────────────────────

type GroupFields = Pick<ProductRow, 'id' | 'variant_group_lead_id'>;

export function isGroupLead(p: GroupFields): boolean {
  return p.variant_group_lead_id != null && p.variant_group_lead_id === p.id;
}

export function isGroupMember(p: GroupFields): boolean {
  return p.variant_group_lead_id != null && p.variant_group_lead_id !== p.id;
}

// ── Pure planning ────────────────────────────────────────────────────────────

const norm = (s: string): string => s.trim().toLowerCase();

type PlanRow = Pick<
  ProductRow,
  'id' | 'sku' | 'shopify_variant_id' | 'variant_options' | 'variant_position' | 'marketplace_excluded'
>;

export interface GroupConfig {
  collapsed_options: string[];
  lead_variant_ids: string[];
}

export interface PlannedGroup {
  key: string;
  /** The kept option values, "Large / Mark I". */
  label: string;
  leadId: string;
  /** Every row in the group, lead included, in Shopify variant order. */
  memberIds: string[];
}

function isCollapsed(name: string, collapsed: string[]): boolean {
  const wanted = norm(name);
  return collapsed.some((c) => norm(c) === wanted);
}

function keptOptions(options: VariantOptionJson[], collapsed: string[]): VariantOptionJson[] {
  return options.filter((o) => !isCollapsed(o.name, collapsed));
}

export function groupKey(options: VariantOptionJson[], collapsed: string[]): string {
  return keptOptions(options, collapsed)
    .map((o) => `${norm(o.name)}=${norm(o.value)}`)
    .join('|');
}

export function byVariantOrder<T extends Pick<ProductRow, 'variant_position' | 'sku'>>(a: T, b: T): number {
  const pa = a.variant_position ?? Number.MAX_SAFE_INTEGER;
  const pb = b.variant_position ?? Number.MAX_SAFE_INTEGER;
  return pa !== pb ? pa - pb : a.sku.localeCompare(b.sku);
}

/**
 * Partitions a Shopify product's (non-archived) variant rows into groups.
 *
 * Rows whose options are not known yet (variant_options = [], i.e. not seen by
 * a webhook or resync since V23) are left out — guessing would lump them all
 * into one group. They stay ungrouped and list on their own until their
 * options arrive.
 *
 * Lead: an explicitly chosen variant, else the first one not excluded from
 * marketplaces, else simply the first.
 */
export function planGroups(rows: PlanRow[], config: GroupConfig): PlannedGroup[] {
  const groups = new Map<string, PlanRow[]>();

  for (const row of [...rows].sort(byVariantOrder)) {
    const options = row.variant_options ?? [];
    if (options.length === 0) continue;

    const key = groupKey(options, config.collapsed_options);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const chosen = new Set(config.lead_variant_ids);

  return [...groups.entries()].map(([key, members]) => {
    const lead =
      members.find((m) => m.shopify_variant_id != null && chosen.has(m.shopify_variant_id)) ??
      members.find((m) => !m.marketplace_excluded) ??
      members[0]!;

    const label = keptOptions(members[0]!.variant_options, config.collapsed_options)
      .map((o) => o.value)
      .join(' / ');

    return { key, label: label || 'All variants', leadId: lead.id, memberIds: members.map((m) => m.id) };
  });
}

/** The distinct values of each collapsed option across a group, in variant order. */
export function collapsedValues(
  members: Pick<ProductRow, 'variant_options' | 'variant_position' | 'sku'>[],
  collapsed: string[],
): Array<{ name: string; values: string[] }> {
  const result = new Map<string, { name: string; values: string[] }>();

  for (const member of [...members].sort(byVariantOrder)) {
    for (const option of member.variant_options ?? []) {
      if (!isCollapsed(option.name, collapsed)) continue;

      const key = norm(option.name);
      const entry = result.get(key) ?? { name: option.name, values: [] };
      if (!entry.values.some((v) => norm(v) === norm(option.value))) entry.values.push(option.value);
      result.set(key, entry);
    }
  }

  return [...result.values()];
}

/**
 * The lead's title with the collapsed option values taken out.
 *
 * Variant titles are Shopify's option values joined by " / ", and the row title
 * is a template around that (see variantTitle in webhook-processor.ts). So the
 * lead's full option string is swapped for the kept one — "Lid - Large / Mark I
 * / Black" becomes "Lid - Large / Mark I". If the template put the values
 * somewhere unrecognisable, each collapsed value is removed with its separator.
 */
export function groupTitle(leadTitle: string, leadOptions: VariantOptionJson[], collapsed: string[]): string {
  const full = leadOptions.map((o) => o.value).join(' / ');
  const kept = keptOptions(leadOptions, collapsed)
    .map((o) => o.value)
    .join(' / ');

  let title = leadTitle;

  if (full !== '' && title.includes(full)) {
    title = title.replace(full, kept);
  } else {
    for (const option of leadOptions) {
      if (!isCollapsed(option.name, collapsed)) continue;
      for (const pattern of [` / ${option.value}`, `${option.value} / `, ` - ${option.value}`, ` — ${option.value}`]) {
        if (title.includes(pattern)) {
          title = title.replace(pattern, '');
          break;
        }
      }
    }
  }

  // A template like "{product} - {variant}" with everything collapsed leaves a
  // dangling separator.
  title = title.replace(/\s{2,}/g, ' ').replace(/[\s\-–—/|,:]+$/u, '').trim();

  return title === '' ? leadTitle : title;
}

type ImageRow = Pick<ProductRow, 'id' | 'image_urls' | 'variant_image_url' | 'variant_position' | 'sku'>;
type SelectionRow = Pick<ProductRow, 'image_urls' | 'listing_image_urls'>;

/** Most photos any marketplace takes (Reverb and Gear Exchange; eBay uses the first 12). */
export const MAX_LISTING_PHOTOS = 25;

/**
 * The operator's hand-picked photos (V24), or null for automatic. Photos no
 * longer on the product — deleted or replaced in Shopify, which changes the
 * URL — are dropped, and a selection left empty counts as automatic, so a
 * stale choice can never publish a broken image or a photo-less listing.
 */
export function selectedImages(row: SelectionRow): string[] | null {
  const picked = row.listing_image_urls;
  if (!Array.isArray(picked) || picked.length === 0) return null;

  const available = new Set(row.image_urls ?? []);
  const kept = [...new Set(picked.filter((u) => typeof u === 'string' && available.has(u)))];
  return kept.length > 0 ? kept.slice(0, MAX_LISTING_PHOTOS) : null;
}

/**
 * The photos that belong to ONE variant, out of its product's photo list.
 *
 * Shopify links at most one photo to a variant (variant.image_id), which would
 * make every variant listing a one-photo listing. So a variant's photos are
 * read the way variant-gallery themes read them: its linked photo, plus the
 * unlinked photos that FOLLOW it in the product's media order, up to the next
 * photo linked to some variant.
 *
 *   [overview, BLACK, black-rear, black-keys, WHITE, white-rear]
 *    └ general  └──── Black ─────────────────┘ └── White ─────┘
 *
 * Photos before the first linked photo are the product's general shots. A
 * variant with its own photo gets none of them — the listing should show the
 * thing being sold, not the overall product. A variant with no photo gets the
 * general shots, or every photo when there are none (a listing without photos
 * fails on Reverb and Gear Exchange, so a wrong-colour photo beats no listing).
 *
 * A product whose variants have no linked photos at all — the t-shirts — is
 * unaffected: every variant gets every photo, as before.
 *
 * Getting the right shots onto a variant is therefore a matter of photo order
 * in Shopify: drag a variant's extra shots to sit right after its linked photo.
 */
export function variantImages(row: ImageRow, siblings: ImageRow[]): string[] {
  const all = row.image_urls ?? [];
  const own = row.variant_image_url;

  // A single-variant product has nothing to tell apart: its linked photo (if
  // any) is just one of the product's photos.
  const variants = new Set([row.id, ...siblings.map((s) => s.id)]);
  if (variants.size < 2) return all;

  const claimed = new Set(
    [row, ...siblings].map((s) => s.variant_image_url).filter((u): u is string => !!u),
  );

  if (own) {
    const start = all.indexOf(own);
    // The linked photo is missing from the product list (stale row): it is
    // still the best photo of this variant there is.
    if (start === -1) return [own];

    const run = [own];
    for (const url of all.slice(start + 1)) {
      if (claimed.has(url)) break;
      run.push(url);
    }
    return run;
  }

  const firstClaimed = all.findIndex((u) => claimed.has(u));
  const general = firstClaimed === -1 ? all : all.slice(0, firstClaimed);
  return general.length > 0 ? general : all;
}

/**
 * What an ungrouped variant lists: the hand-picked photos when there are any,
 * otherwise the automatic ones. (A group lead goes through groupedProduct.)
 */
export function listingImages(row: ImageRow & SelectionRow, siblings: ImageRow[]): string[] {
  return selectedImages(row) ?? variantImages(row, siblings);
}

/**
 * Photos for a group listing: the lead variant's photos first, then each other
 * member's photos (see variantImages). Photos of variants OUTSIDE the group are
 * left out — a Small lid's photo has no place on the Large listing — and so are
 * the product's general shots, as on an ungrouped variant listing.
 *
 * When no variant in the group has its own photo, the group gets what a lone
 * photo-less variant would: the general shots, else every product photo.
 */
export function groupImages(lead: ImageRow, members: ImageRow[], siblings: ImageRow[]): string[] {
  const ordered = [lead, ...members.filter((m) => m.id !== lead.id).sort(byVariantOrder)];
  const withPhotos = ordered.filter((m) => !!m.variant_image_url);

  if (withPhotos.length === 0) return variantImages(lead, siblings);

  return [...new Set(withPhotos.flatMap((m) => variantImages(m, siblings)))];
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function joinNames(names: string[]): string {
  const lower = names.map((n) => n.toLowerCase());
  if (lower.length <= 1) return lower[0] ?? 'option';
  return `${lower.slice(0, -1).join(', ')} and ${lower[lower.length - 1]}`;
}

/** The note appended to a group listing's description (HTML, like Shopify's body_html). */
export function buyerNoteHtml(values: Array<{ name: string; values: string[] }>, note: string | null): string {
  const lines = values
    .filter((v) => v.values.length > 0)
    .map((v) => `<p><strong>${escapeHtml(v.name)} options:</strong> ${escapeHtml(v.values.join(', '))}</p>`);

  const template = note && note.trim() !== '' ? note : DEFAULT_BUYER_NOTE;
  const sentence = template.replace(/\{options\}/g, joinNames(values.map((v) => v.name)));
  lines.push(`<p>${escapeHtml(sentence)}</p>`);

  return lines.join('\n');
}

/** Plain-text version for the Shopify order note. */
export function optionsSummary(values: Array<{ name: string; values: string[] }>): string {
  return values.map((v) => `${v.name}: ${v.values.join(', ')}`).join('; ');
}

/**
 * The lead row as the marketplaces should see the whole group. Pure — the
 * caller supplies the rows. See the file comment for what changes.
 */
export function groupedProduct(
  lead: ProductRow,
  members: ProductRow[],
  siblings: ProductRow[],
  grouping: Pick<VariantGroupingRow, 'collapsed_options' | 'buyer_note'>,
): ProductRow {
  const all = members.some((m) => m.id === lead.id) ? members : [lead, ...members];
  const values = collapsedValues(all, grouping.collapsed_options);
  const note = buyerNoteHtml(values, grouping.buyer_note);
  const base = lead.description && lead.description.trim() !== '' ? lead.description : '';

  const specials = all.map((m) => m.special_order_quantity).filter((q): q is number => q != null);

  return {
    ...lead,
    title: groupTitle(lead.title, lead.variant_options ?? [], grouping.collapsed_options),
    description: base === '' ? note : `${base}\n${note}`,
    image_urls: selectedImages(lead) ?? groupImages(lead, all, siblings),
    // Real stock across every colour. A special-order group with none in stock
    // lists at the special-order quantity, exactly as a single variant would.
    quantity: all.reduce((sum, m) => sum + Math.max(0, m.quantity), 0),
    special_order_quantity: lead.special_order_quantity ?? (specials.length > 0 ? Math.max(...specials) : null),
  };
}

// ── Database ─────────────────────────────────────────────────────────────────

export async function getGrouping(
  shopifyProductId: string,
  ex: Executor = db,
): Promise<VariantGroupingRow | undefined> {
  return ex
    .selectFrom('variant_groupings')
    .selectAll()
    .where('shopify_product_id', '=', shopifyProductId)
    .executeTakeFirst();
}

async function groupRows(leadId: string, ex: Executor): Promise<ProductRow[]> {
  return ex
    .selectFrom('products')
    .selectAll()
    .where('variant_group_lead_id', '=', leadId)
    .where('status', '!=', 'ARCHIVED')
    .execute();
}

/**
 * What a connector should publish for this row: the grouped view for a group
 * lead, otherwise the row itself with only its own variant's photos (picked
 * by hand, or worked out by variantImages). Every publish, update and inventory sync goes
 * through this (sync-dispatcher.ts).
 */
export async function listingProduct(product: ProductRow, ex: Executor = db): Promise<ProductRow> {
  if (!product.shopify_product_id) return product;

  // An ungrouped variant lists its own photos only (see variantImages).
  if (!isGroupLead(product)) {
    const siblings = await ex
      .selectFrom('products')
      .select(['id', 'image_urls', 'variant_image_url', 'variant_position', 'sku'])
      .where('shopify_product_id', '=', product.shopify_product_id)
      .execute();
    return { ...product, image_urls: listingImages(product, siblings) };
  }

  const grouping = await getGrouping(product.shopify_product_id, ex);
  if (!grouping) return product; // stale lead id; the next regroup clears it

  const [members, siblings] = await Promise.all([
    groupRows(product.id, ex),
    ex.selectFrom('products').selectAll().where('shopify_product_id', '=', product.shopify_product_id).execute(),
  ]);

  return groupedProduct(product, members, siblings, grouping);
}

/**
 * How many a buyer can order on the marketplace that lists this row's group:
 * channelQuantity() of the whole group for a lead or member, of the row itself
 * otherwise.
 */
export async function marketplaceQuantity(product: ProductRow, ex: Executor = db): Promise<number> {
  if (!product.variant_group_lead_id) return channelQuantity(product);
  const lead = await ex
    .selectFrom('products')
    .selectAll()
    .where('id', '=', product.variant_group_lead_id)
    .executeTakeFirst();
  if (!lead) return channelQuantity(product);
  return channelQuantity(await listingProduct(lead, ex));
}

export interface RegroupResult {
  /** Final lead id per product id (null = ungrouped), for patching rows held in memory. */
  leadByProductId: Map<string, string | null>;
  /** Rows that were not members before and are now — taken off marketplaces. */
  becameMembers: string[];
  /** Rows that were in a group and now are not. */
  leftGroups: string[];
  /** Group leads after the regroup. */
  leadIds: string[];
}

/**
 * Re-derives variant_group_lead_id for every row of a Shopify product from its
 * grouping (or clears it when there is none), and takes rows that just became
 * members off the marketplaces — a live listing is delisted, review stubs are
 * removed (the same side effects as excluding a product).
 *
 * Called after every Shopify upsert of the product (new variants, renamed
 * options) and whenever the grouping is edited. Idempotent: a regroup that
 * changes nothing writes nothing.
 *
 * Creating review stubs for leads and re-including ungrouped rows is NOT done
 * here — upsertReviewListings owns that, and the callers run it next.
 */
export async function regroupProduct(shopifyProductId: string, ex: Executor = db): Promise<RegroupResult> {
  const [rows, grouping] = await Promise.all([
    ex.selectFrom('products').selectAll().where('shopify_product_id', '=', shopifyProductId).execute(),
    getGrouping(shopifyProductId, ex),
  ]);

  const desired = new Map<string, string | null>(rows.map((r) => [r.id, null]));

  if (grouping) {
    const live = rows.filter((r) => r.status !== 'ARCHIVED');
    for (const group of planGroups(live, grouping)) {
      for (const id of group.memberIds) desired.set(id, group.leadId);
    }
  }

  const becameMembers: string[] = [];
  const leftGroups: string[] = [];

  for (const row of rows) {
    const next = desired.get(row.id) ?? null;
    if (next === row.variant_group_lead_id) continue;

    await ex
      .updateTable('products')
      .set({ variant_group_lead_id: next, updated_at: new Date() })
      .where('id', '=', row.id)
      .execute();

    const wasMember = isGroupMember(row);
    const nowMember = next != null && next !== row.id;

    if (nowMember && !wasMember) {
      becameMembers.push(row.id);
      await removeFromMarketplaces(ex, row.id, row.sku, 'variant_grouped');
    }
    if (next == null) leftGroups.push(row.id);
  }

  const leadIds = [...new Set([...desired.values()].filter((v): v is string => v != null))];

  if (becameMembers.length > 0 || leftGroups.length > 0) {
    log.info(
      { shopifyProductId, groups: leadIds.length, becameMembers: becameMembers.length, leftGroups: leftGroups.length },
      'Regrouped variants',
    );
  }

  return { leadByProductId: desired, becameMembers, leftGroups, leadIds };
}
