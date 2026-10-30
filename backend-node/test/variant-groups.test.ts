import { describe, expect, it } from 'vitest';

import type { ProductRow, VariantOptionJson } from '../src/db/types.js';
import { variantShape } from '../src/marketplace/shopify/variant-shape.js';
import { checkEligibility } from '../src/services/marketplace-eligibility.js';
import { channelQuantity } from '../src/services/special-order.js';
import {
  buyerNoteHtml,
  collapsedValues,
  groupedProduct,
  groupImages,
  groupTitle,
  isGroupLead,
  isGroupMember,
  planGroups,
} from '../src/services/variant-groups.js';

/**
 * The lid case: 2 sizes × 2 cuts × 3 colours = 12 variants → 4 listings.
 */

const SIZES = ['Large', 'Small'];
const CUTS = ['Mark I', 'Mark II'];
const COLORS = ['Black', 'Red', 'Cream'];

const img = (s: string) => `https://cdn.example/${s.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`;
const GENERAL = img('lid-on-piano');

function opts(size: string, cut: string, color: string): VariantOptionJson[] {
  return [
    { name: 'Size', value: size },
    { name: 'Cut', value: cut },
    { name: 'Color', value: color },
  ];
}

function variant(i: number, size: string, cut: string, color: string, extra: Partial<ProductRow> = {}): ProductRow {
  const name = `${size} / ${cut} / ${color}`;
  return {
    id: `p-${i}`,
    sku: `LID-${i}`,
    title: `Rhodes Lid - ${name}`,
    description: '<p>Custom fabricated lid.</p>',
    brand: 'CEPCo',
    category: 'Parts',
    condition: 'NEW',
    price: '450.00',
    quantity: 0,
    image_urls: [],
    shopify_product_id: '999',
    shopify_variant_id: `v-${i}`,
    status: 'ACTIVE',
    marketplace_excluded: false,
    excluded_marketplaces: [],
    special_order_quantity: 2,
    variant_options: opts(size, cut, color),
    variant_position: i,
    variant_image_url: img(name),
    variant_group_lead_id: null,
    ...extra,
  } as ProductRow;
}

function catalogue(): ProductRow[] {
  const rows: ProductRow[] = [];
  let i = 1;
  for (const size of SIZES) for (const cut of CUTS) for (const color of COLORS) rows.push(variant(i++, size, cut, color));
  const allImages = [...rows.map((r) => r.variant_image_url!), GENERAL];
  return rows.map((r) => ({ ...r, image_urls: allImages }));
}

const COLOR_ONLY = { collapsed_options: ['Color'], lead_variant_ids: [] as string[] };

describe('planGroups', () => {
  it('collapses colour into one group per size × cut', () => {
    const groups = planGroups(catalogue(), COLOR_ONLY);
    expect(groups.map((g) => g.label)).toEqual([
      'Large / Mark I',
      'Large / Mark II',
      'Small / Mark I',
      'Small / Mark II',
    ]);
    expect(groups.every((g) => g.memberIds.length === 3)).toBe(true);
  });

  it('leads with the first variant by default, or the chosen one', () => {
    expect(planGroups(catalogue(), COLOR_ONLY)[0]!.leadId).toBe('p-1');
    // v-2 is Large / Mark I / Red
    expect(planGroups(catalogue(), { ...COLOR_ONLY, lead_variant_ids: ['v-2'] })[0]!.leadId).toBe('p-2');
  });

  it('matches option names case-insensitively', () => {
    expect(planGroups(catalogue(), { ...COLOR_ONLY, collapsed_options: ['color'] })).toHaveLength(4);
  });

  it('does not lead with a marketplace-excluded variant unless chosen', () => {
    const rows = catalogue().map((r) => (r.id === 'p-1' ? { ...r, marketplace_excluded: true } : r));
    expect(planGroups(rows, COLOR_ONLY)[0]!.leadId).toBe('p-2');
  });

  it('leaves variants with unknown options out rather than lumping them together', () => {
    const rows = catalogue().map((r) => (r.id === 'p-12' ? { ...r, variant_options: [] } : r));
    const groups = planGroups(rows, COLOR_ONLY);
    expect(groups.flatMap((g) => g.memberIds)).not.toContain('p-12');
  });

  it('a new size appears as new groups on its own', () => {
    const rows = [...catalogue(), variant(13, 'Medium', 'Mark I', 'Black'), variant(14, 'Medium', 'Mark I', 'Red')];
    expect(planGroups(rows, COLOR_ONLY)).toHaveLength(5);
  });
});

describe('groupTitle', () => {
  it('drops the collapsed value from the variant part of the title', () => {
    expect(groupTitle('Rhodes Lid - Large / Mark I / Black', opts('Large', 'Mark I', 'Black'), ['Color'])).toBe(
      'Rhodes Lid - Large / Mark I',
    );
  });

  it('works when the collapsed option is not last', () => {
    const o: VariantOptionJson[] = [
      { name: 'Color', value: 'Black' },
      { name: 'Size', value: 'Large' },
    ];
    expect(groupTitle('Lid - Black / Large', o, ['Color'])).toBe('Lid - Large');
  });

  it('leaves no dangling separator when everything is collapsed', () => {
    expect(groupTitle('Rhodes Lid - Black', [{ name: 'Color', value: 'Black' }], ['Color'])).toBe('Rhodes Lid');
  });
});

describe('groupImages', () => {
  it('puts the lead photo first, then the group, then general shots — never other groups', () => {
    const rows = catalogue();
    const members = rows.slice(0, 3); // Large / Mark I in Black, Red, Cream
    const lead = members[1]!; // Red

    expect(groupImages(lead, members, rows)).toEqual([
      img('Large / Mark I / Red'),
      img('Large / Mark I / Black'),
      img('Large / Mark I / Cream'),
      GENERAL,
    ]);
  });

  it('falls back to the product photos when no variant has its own', () => {
    const rows = catalogue().map((r) => ({ ...r, variant_image_url: null }));
    expect(groupImages(rows[0]!, rows.slice(0, 3), rows)).toEqual(rows[0]!.image_urls);
  });
});

describe('groupedProduct', () => {
  const grouping = { collapsed_options: ['Color'], buyer_note: null };

  it('builds the listing view of a group', () => {
    const rows = catalogue();
    const members = rows.slice(0, 3).map((r, i) => ({ ...r, quantity: i })); // 0 + 1 + 2
    const grouped = groupedProduct(members[0]!, members, rows, grouping);

    expect(grouped.id).toBe('p-1');
    expect(grouped.sku).toBe('LID-1');
    expect(grouped.title).toBe('Rhodes Lid - Large / Mark I');
    expect(grouped.quantity).toBe(3);
    expect(grouped.description).toContain('<strong>Color options:</strong> Black, Red, Cream');
    expect(grouped.description).toContain('send us a message with the color you would like');
    expect(grouped.image_urls[0]).toBe(img('Large / Mark I / Black'));
  });

  it('lists a special-order group with no stock at the special-order quantity', () => {
    const rows = catalogue();
    const grouped = groupedProduct(rows[0]!, rows.slice(0, 3), rows, grouping);
    expect(channelQuantity(grouped)).toBe(2);
  });

  it('uses a custom note', () => {
    const rows = catalogue();
    const grouped = groupedProduct(rows[0]!, rows.slice(0, 3), rows, {
      ...grouping,
      buyer_note: 'Tell us your {options} & we will build it.',
    });
    expect(grouped.description).toContain('Tell us your color &amp; we will build it.');
  });
});

describe('collapsedValues / buyerNoteHtml', () => {
  it('lists each collapsed option once, in variant order', () => {
    expect(collapsedValues(catalogue(), ['Color'])).toEqual([{ name: 'Color', values: COLORS }]);
  });

  it('escapes option values', () => {
    expect(buyerNoteHtml([{ name: 'Color', values: ['<b>Red</b>'] }], null)).toContain('&lt;b&gt;Red&lt;/b&gt;');
  });
});

describe('eligibility', () => {
  const reverb = { marketplace_type: 'REVERB' as const, sync_settings: {} };

  it('keeps group members off marketplaces and lets the lead list', () => {
    const lead = { ...variant(1, 'Large', 'Mark I', 'Black'), variant_group_lead_id: 'p-1' };
    const member = { ...variant(2, 'Large', 'Mark I', 'Red'), variant_group_lead_id: 'p-1' };

    expect(isGroupLead(lead)).toBe(true);
    expect(isGroupMember(member)).toBe(true);
    expect(checkEligibility(lead, reverb).eligible).toBe(true);
    expect(checkEligibility(member, reverb)).toEqual({
      eligible: false,
      reason: "Sold through its variant group's listing",
    });
  });
});

describe('variantShape', () => {
  const product = {
    options: [
      { name: 'Size', position: 1 },
      { name: 'Cut', position: 2 },
      { name: 'Color', position: 3 },
    ],
    images: [
      { id: 10, src: 'https://cdn.example/black.jpg' },
      { id: 11, src: 'https://cdn.example/red.jpg' },
    ],
  };

  it('reads options, position and the variant photo', () => {
    expect(
      variantShape(product, { option1: 'Large', option2: 'Mark I', option3: 'Red', position: 2, image_id: 11 }),
    ).toEqual({
      variant_options: opts('Large', 'Mark I', 'Red'),
      variant_position: 2,
      variant_image_url: 'https://cdn.example/red.jpg',
    });
  });

  it('ignores the implicit option of a product without options', () => {
    expect(
      variantShape({ options: [{ name: 'Title', position: 1 }] }, { option1: 'Default Title', position: 1 }),
    ).toEqual({ variant_options: [], variant_position: 1, variant_image_url: null });
  });
});
