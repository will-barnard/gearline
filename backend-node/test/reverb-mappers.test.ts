import { describe, expect, it } from 'vitest';

import { mapCondition, toReverbRequest } from '../src/marketplace/reverb/listing-mapper.js';
import { toImportedOrder } from '../src/marketplace/reverb/order-mapper.js';
import type { ProductRow } from '../src/db/types.js';
import type { PublishListingRequest } from '../src/marketplace/types.js';
import type { ReverbOrderDto } from '../src/marketplace/reverb/types.js';

/** Ports ReverbListingMapperTest and ReverbOrderMapperTest. */

function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    sku: 'GTR-001',
    title: '1965 Fender Stratocaster',
    description: 'A lovely guitar',
    brand: 'Fender',
    category: 'Electric Guitars',
    condition: 'EXCELLENT',
    price: '2400.00',
    quantity: 1,
    weight_kg: '3.5',
    dim_length_in: '48.000',
    dim_width_in: '18.000',
    dim_height_in: '6.000',
    serial_number: 'L12345',
    image_urls: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'],
    shopify_product_id: null,
    shopify_variant_id: null,
    shopify_inventory_item_id: null,
    status: 'ACTIVE',
    version: '0',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    video_url: null,
    model: 'Stratocaster',
    year_made: '1965',
    finish: 'Sunburst',
    condition_notes: 'Minor buckle rash',
    marketplace_excluded: false,
    ...overrides,
  } as ProductRow;
}

function request(overrides: Partial<PublishListingRequest> = {}): PublishListingRequest {
  return {
    titleOverride: null,
    descriptionOverride: null,
    priceOverride: null,
    quantity: 1,
    imageUrls: ['https://cdn.example/1.jpg'],
    categoryId: null,
    conditionMapping: null,
    shippingDetails: {
      weightOz: '123.459',
      lengthIn: '48.000',
      widthIn: '18.000',
      heightIn: '6.000',
      shippingProfileName: null,
      insuranceValueUsd: '3000',
    },
    extraParams: {},
    ...overrides,
  };
}

/** Unwraps the { listing: {...} } envelope. */
function listingBody(p = product(), r = request()): Record<string, unknown> {
  return toReverbRequest(p, r).listing as Record<string, unknown>;
}

describe('ReverbListingMapper — condition slugs', () => {
  it.each([
    ['NEW', 'brand-new'],
    ['MINT', 'mint'],
    ['EXCELLENT', 'excellent'],
    ['VERY_GOOD', 'very-good'],
    ['GOOD', 'good'],
    ['FAIR', 'fair'],
    ['POOR', 'poor'],
    ['OPEN_BOX', 'b-stock'],
    ['USED', 'used'],
    ['FOR_PARTS', 'non-functioning'],
  ] as const)('%s -> %s', (condition, slug) => {
    expect(mapCondition(condition)).toBe(slug);
  });

  it('defaults to "used" when condition is missing', () => {
    expect(mapCondition(null)).toBe('used');
  });
});

describe('ReverbListingMapper — required fields', () => {
  it('sends inventory as a FLAT integer alongside has_inventory', () => {
    // Not { total: n } — the nested form silently fails to set stock.
    const body = listingBody(product(), request({ quantity: 3 }));
    expect(body['has_inventory']).toBe(true);
    expect(body['inventory']).toBe(3);
  });

  it('sends photos as plain URL strings, not objects', () => {
    const body = listingBody(
      product(),
      request({ imageUrls: ['https://a.jpg', 'https://b.jpg'] }),
    );
    expect(body['photos']).toEqual(['https://a.jpg', 'https://b.jpg']);
  });

  it('omits photos entirely when there are none', () => {
    expect(listingBody(product(), request({ imageUrls: [] }))).not.toHaveProperty('photos');
  });

  it('falls back to "Unknown" for a missing make', () => {
    // Reverb rejects a listing with no make; "Unknown" at least publishes.
    expect(listingBody(product({ brand: null }))['make']).toBe('Unknown');
  });

  it('cascades model: override -> product.model -> category -> title', () => {
    expect(listingBody(product(), request({ extraParams: { reverb_model: 'Custom Shop' } }))['model'])
      .toBe('Custom Shop');

    expect(listingBody(product())['model']).toBe('Stratocaster');

    expect(listingBody(product({ model: null }))['model']).toBe('Electric Guitars');

    expect(listingBody(product({ model: null, category: null }))['model'])
      .toBe('1965 Fender Stratocaster');
  });

  it('falls back to the title when there is no description', () => {
    // An empty description is rejected by Reverb.
    expect(listingBody(product({ description: null }))['description'])
      .toBe('1965 Fender Stratocaster');
  });

  it('sends price as a decimal string, never a number', () => {
    const price = listingBody()['price'] as { amount: unknown; currency: string };
    expect(price.amount).toBe('2400.00');
    expect(typeof price.amount).toBe('string');
    expect(price.currency).toBe('USD');
  });

  it('honours a price override from the pricing profile', () => {
    const body = listingBody(product(), request({ priceOverride: '2772.00' }));
    expect((body['price'] as { amount: string }).amount).toBe('2772.00');
  });
});

describe('ReverbListingMapper — shipping', () => {
  it('prefers a shipping profile and omits weight/dimensions', () => {
    const body = listingBody(
      product(),
      request({
        shippingDetails: {
          weightOz: '123.459',
          lengthIn: '48.000',
          widthIn: '18.000',
          heightIn: '6.000',
          shippingProfileName: '456',
          insuranceValueUsd: '3000',
        },
      }),
    );

    // The API field is shipping_profile_id despite the internal name.
    expect(body['shipping_profile_id']).toBe('456');
    expect(body).not.toHaveProperty('weight');
    expect(body).not.toHaveProperty('dimensions');
  });

  it('emits weight and dimensions when no profile is set', () => {
    const body = listingBody();
    expect(body['weight']).toEqual({ value: '123.459', unit: 'oz' });
    expect(body['dimensions']).toEqual({
      length: '48.000',
      width: '18.000',
      height: '6.000',
      unit: 'in',
    });
  });

  it('omits dimensions unless ALL THREE are present', () => {
    // Reverb rejects a partial dimensions object, failing the whole publish.
    const body = listingBody(
      product(),
      request({
        shippingDetails: {
          weightOz: '123.459',
          lengthIn: '48.000',
          widthIn: '18.000',
          heightIn: null,
          shippingProfileName: null,
          insuranceValueUsd: '3000',
        },
      }),
    );

    expect(body).not.toHaveProperty('dimensions');
    expect(body['weight']).toEqual({ value: '123.459', unit: 'oz' });
  });
});

describe('ReverbListingMapper — passthrough', () => {
  it('forwards unknown keys but strips marketplace-prefixed ones', () => {
    const body = listingBody(
      product(),
      request({
        extraParams: {
          reverb_model: 'Custom Shop',
          ebay_fulfillment_policy_id: 'should-not-appear',
          some_new_reverb_field: 'passthrough',
        },
      }),
    );

    expect(body['some_new_reverb_field']).toBe('passthrough');
    expect(body).not.toHaveProperty('ebay_fulfillment_policy_id');
    expect(body).not.toHaveProperty('reverb_model');
    expect(body['model']).toBe('Custom Shop');
  });

  it('maps condition notes to condition_description', () => {
    expect(listingBody()['condition_description']).toBe('Minor buckle rash');
  });
});

describe('ReverbOrderMapper', () => {
  const baseOrder: ReverbOrderDto = {
    order_id: 25262223,
    buyer_name: 'Jane Smith',
    buyer_id: 'buyer-1',
    buyer_email: 'jane@example.com',
    amount_product: { amount: '2400.00', currency: 'USD' },
    amount_shipping: { amount: '75.00', currency: 'USD' },
    amount_tax: { amount: '0.00', currency: 'USD' },
    amount_total: { amount: '2475.00', currency: 'USD' },
    created_at: '2026-03-01T12:00:00Z',
    _links: { web: { href: 'https://reverb.com/my/selling/orders/25262223' } },
    listing: { id: 'L-99', sku: 'GTR-001', title: '1965 Fender Stratocaster' },
    quantity: 1,
  };

  it('coerces the numeric order_id to a string', () => {
    // Reverb returns this as an integer; the column is a string.
    const result = toImportedOrder(baseOrder);
    expect(result?.externalOrderId).toBe('25262223');
  });

  it('falls back to the URL when order_id is missing', () => {
    const result = toImportedOrder({ ...baseOrder, order_id: undefined });
    expect(result?.externalOrderId).toBe('25262223');
  });

  it('returns null when there is no identifiable ID at all', () => {
    // Must be filtered out — otherwise it hits the NOT NULL constraint.
    const result = toImportedOrder({ ...baseOrder, order_id: undefined, _links: undefined });
    expect(result).toBeNull();
  });

  it('carries the SKU through, since inventory deduction depends on it', () => {
    const result = toImportedOrder(baseOrder);
    expect(result?.lineItems).toHaveLength(1);
    expect(result?.lineItems[0]?.sku).toBe('GTR-001');
    expect(result?.lineItems[0]?.quantity).toBe(1);
  });

  it('splits buyer_name on the FIRST space only', () => {
    const result = toImportedOrder({ ...baseOrder, buyer_name: 'Mary Jane Watson' });
    expect(result?.buyerInfo?.firstName).toBe('Mary');
    expect(result?.buyerInfo?.lastName).toBe('Jane Watson');
  });

  it('handles a single-word buyer name', () => {
    const result = toImportedOrder({ ...baseOrder, buyer_name: 'Prince' });
    expect(result?.buyerInfo?.firstName).toBe('Prince');
    expect(result?.buyerInfo?.lastName).toBe('');
  });

  it('keeps money as decimal strings', () => {
    const result = toImportedOrder(baseOrder);
    expect(result?.totalAmount).toBe('2475.00');
    expect(result?.shippingTotal).toBe('75.00');
    expect(typeof result?.totalAmount).toBe('string');
  });

  it('returns "0" for a missing amount', () => {
    const result = toImportedOrder({ ...baseOrder, amount_tax: undefined });
    expect(result?.taxTotal).toBe('0');
  });

  it('returns null for an unparseable date rather than falling back to now', () => {
    // Defaulting to now() silently corrupts order-date analytics.
    const result = toImportedOrder({ ...baseOrder, created_at: 'not-a-date' });
    expect(result?.createdAt).toBeNull();
  });

  it('maps the shipping address to internal field names', () => {
    const result = toImportedOrder({
      ...baseOrder,
      shipping_address: {
        street_address: '1 Main St',
        extended_address: 'Apt 2',
        locality: 'Chicago',
        region: 'IL',
        postal_code: '60601',
        country_code: 'US',
      },
    });

    expect(result?.shippingAddress).toEqual({
      line1: '1 Main St',
      line2: 'Apt 2',
      city: 'Chicago',
      state: 'IL',
      postalCode: '60601',
      country: 'US',
    });
  });

  it('returns empty line items when the listing object is absent', () => {
    const result = toImportedOrder({ ...baseOrder, listing: undefined });
    expect(result?.lineItems).toEqual([]);
    expect(result?.externalOrderId).toBe('25262223');
  });
});
