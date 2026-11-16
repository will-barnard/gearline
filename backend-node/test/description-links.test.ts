import { describe, expect, it } from 'vitest';

import type { MarketplaceAccountRow, ProductRow } from '../src/db/types.js';
import { countLinks, stripLinks } from '../src/services/description-links.js';
import { resolve } from '../src/services/listing-attribute-resolver.js';

/**
 * The same table lives in the frontend copy of this logic
 * (frontend/src/lib/stripLinks.js). Keep them in step.
 */
const CASES: Array<[name: string, input: string, expected: string, links: number]> = [
  ['plain text is untouched', 'Plain text, nothing here.', 'Plain text, nothing here.', 0],
  ['anchor keeps its words', 'See <a href="https://x.com/a">our shop</a> for more.', 'See our shop for more.', 1],
  ['anchor whose text is the URL goes entirely', '<p>Manual: <a href="https://x.com/m.pdf">https://x.com/m.pdf</a></p>', '<p>Manual:</p>', 1],
  ['bare URL keeps sentence punctuation', 'Visit https://www.reverb.com/shop/foo. Thanks', 'Visit. Thanks', 1],
  ['bare URL in parentheses', 'Details (see https://x.com/y) below', 'Details (see) below', 1],
  ['www. without a scheme', 'Go to www.example.com now', 'Go to now', 1],
  ['image src is not a link', '<img src="https://cdn.shopify.com/a.jpg"> pic', '<img src="https://cdn.shopify.com/a.jpg"> pic', 0],
  ['emptied paragraph is dropped', '<p>A</p><p><a href="https://x.com"></a></p><p>B</p>', '<p>A</p><p>B</p>', 1],
  ['mailto and uppercase attributes', '<a href="mailto:a@b.com">email me</a> or <a HREF="http://y.com" target="_blank">here</a>', 'email me or here', 2],
  ['formatting inside the anchor survives', '<strong><a href="https://x.com">bold link</a></strong>', '<strong>bold link</strong>', 1],
];

describe('stripLinks', () => {
  it.each(CASES)('%s', (_name, input, expected, links) => {
    expect(stripLinks(input)).toBe(expected);
    expect(countLinks(input)).toBe(links);
    // Idempotent, and nothing left for the button/flag to act on.
    expect(stripLinks(expected)).toBe(expected);
    expect(countLinks(stripLinks(input))).toBe(0);
  });

  it('removes an unclosed anchor tag but keeps its text', () => {
    expect(stripLinks('Unclosed <a href="https://x.com">anchor text')).toBe('Unclosed anchor text');
  });
});

describe('resolve(): strip_links', () => {
  const product = {
    id: 'p1',
    sku: 'SKU-1',
    title: 'Rhodes Tine',
    description: '<p>Great tine. <a href="https://example.com/spec">Spec sheet</a> https://example.com/more</p>',
    brand: 'Rhodes',
    category: 'Parts',
    condition: 'USED',
    price: '25.00',
    quantity: 1,
    image_urls: [],
    special_order_quantity: null,
  } as unknown as ProductRow;

  const listing = (overrides: Record<string, unknown>) => ({
    marketplace_type: 'REVERB' as const,
    listing_overrides: overrides,
  });

  const account = (suffix: string | null) =>
    ({ sync_settings: suffix === null ? {} : { description_suffix: suffix } }) as unknown as MarketplaceAccountRow;

  it('leaves links alone unless the flag is on', () => {
    expect(resolve(product, listing({}), null).descriptionOverride).toBe(product.description);
    expect(resolve(product, listing({ strip_links: false }), null).descriptionOverride).toBe(product.description);
    // A stray string must not switch it on.
    expect(resolve(product, listing({ strip_links: 'false' }), null).descriptionOverride).toBe(product.description);
  });

  it('strips the product description when the flag is on', () => {
    expect(resolve(product, listing({ strip_links: true }), null).descriptionOverride).toBe('<p>Great tine. Spec sheet</p>');
  });

  it('follows a Shopify edit — the flag is re-applied to whatever the description is now', () => {
    const edited = { ...product, description: 'Rewritten copy, see https://example.com/new for photos' } as ProductRow;
    expect(resolve(edited, listing({ strip_links: true }), null).descriptionOverride).toBe('Rewritten copy, see for photos');
  });

  it('also cleans a description override', () => {
    const out = resolve(product, listing({ strip_links: true, description: 'Mine <a href="https://a.com">here</a>' }), null);
    expect(out.descriptionOverride).toBe('Mine here');
  });

  it('does not strip the account suffix, and the flag never reaches extraParams', () => {
    const out = resolve(product, listing({ strip_links: true }), account('Shop policy: https://shop.example.com/returns'));
    expect(out.descriptionOverride).toBe('<p>Great tine. Spec sheet</p>\n\nShop policy: https://shop.example.com/returns');
    expect(out.extraParams).not.toHaveProperty('strip_links');
  });
});
