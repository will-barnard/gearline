import { describe, expect, it } from 'vitest';

import type { MarketplaceAccountRow, ProductRow } from '../src/db/types.js';
import { normaliseOptions, unwrapListing, isImageProcessingLock } from '../src/marketplace/gear-exchange/client.js';
import { explainError } from '../src/marketplace/gear-exchange/connector.js';
import {
  assertPriceAllowed,
  conditionFor,
  htmlToText,
  madeYear,
  mapCondition,
  titleWithoutBrand,
  toGxRequest,
} from '../src/marketplace/gear-exchange/listing-mapper.js';
import { gearlineProductId, isDeadOrder, toImportedOrder } from '../src/marketplace/gear-exchange/order-mapper.js';
import { configuredCategoryFor } from '../src/marketplace/gear-exchange/reference.js';
import { checkEligibility } from '../src/services/marketplace-eligibility.js';
import { PermanentMarketplaceError, type PublishListingRequest } from '../src/marketplace/types.js';

function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    sku: 'RHD-TINE-01',
    title: 'Rhodes Mark I Tine Assembly',
    description: '<p>Original tine.</p><ul><li>Tested</li><li>Clean</li></ul>',
    brand: 'Rhodes',
    category: 'Parts',
    condition: 'USED',
    price: '45.00',
    quantity: 3,
    weight_kg: '0.2',
    dim_length_in: null,
    dim_width_in: null,
    dim_height_in: null,
    serial_number: null,
    image_urls: ['https://cdn.example/1.jpg'],
    shopify_product_id: null,
    shopify_variant_id: null,
    shopify_inventory_item_id: null,
    status: 'ACTIVE',
    version: '0',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    video_url: null,
    model: null,
    year_made: '1977',
    finish: null,
    condition_notes: null,
    marketplace_excluded: false,
    excluded_marketplaces: [],
    ...overrides,
  };
}

function request(overrides: Partial<PublishListingRequest> = {}): PublishListingRequest {
  return {
    titleOverride: null,
    descriptionOverride: null,
    priceOverride: null,
    quantity: 3,
    imageUrls: ['https://cdn.example/1.jpg'],
    categoryId: null,
    conditionMapping: null,
    shippingDetails: null,
    extraParams: {},
    ...overrides,
  };
}

const account = {
  sync_settings: { gx_shipping_cost: '12.50', gx_return_policy_days: '7' },
} as Pick<MarketplaceAccountRow, 'sync_settings'>;

describe('Gear Exchange listing mapper', () => {
  it('maps internal conditions to GX grades', () => {
    expect(mapCondition('OPEN_BOX')).toBe('Mint');
    expect(mapCondition('NEW')).toBe('Mint');
    expect(mapCondition('USED')).toBe('Good');
    expect(mapCondition('VERY_GOOD')).toBe('Excellent');
    expect(mapCondition('FOR_PARTS')).toBe('Poor');
  });

  it('picks the condition: listing override, then account map, then default', () => {
    const acct = { sync_settings: { gx_condition_map: { OPEN_BOX: 'Excellent' } } };
    expect(conditionFor({ condition: 'OPEN_BOX' }, { conditionMapping: null }, acct)).toBe('Excellent');
    expect(conditionFor({ condition: 'OPEN_BOX' }, { conditionMapping: '4' }, acct)).toBe('4');
    expect(conditionFor({ condition: 'MINT' }, { conditionMapping: null }, acct)).toBe('Mint');
    expect(conditionFor({ condition: 'OPEN_BOX' }, { conditionMapping: null }, { sync_settings: {} })).toBe('Mint');
  });

  it('strips a leading brand from the title', () => {
    expect(titleWithoutBrand('Rhodes Mark I Tine', 'Rhodes')).toBe('Mark I Tine');
    expect(titleWithoutBrand('Rhodes - Mark I', 'rhodes')).toBe('Mark I');
    expect(titleWithoutBrand('Rhodes', 'Rhodes')).toBe('Rhodes');
    expect(titleWithoutBrand('Mark I Tine', 'Rhodes')).toBe('Mark I Tine');
  });

  it('converts HTML descriptions to plain text', () => {
    expect(htmlToText('<p>Original tine.</p><ul><li>Tested</li><li>Clean</li></ul>')).toBe(
      'Original tine.\n\n- Tested\n- Clean',
    );
    expect(htmlToText('A &amp; B<br>C')).toBe('A & B\nC');
  });

  it('extracts a usable year', () => {
    expect(madeYear('1977')).toBe(1977);
    expect(madeYear('circa 1974')).toBe(1974);
    expect(madeYear('1700s')).toBeNull();
    expect(madeYear(null)).toBeNull();
  });

  it('enforces the $25 floor and $10k cap', () => {
    expect(() => assertPriceAllowed('25.00')).toThrow(/above \$25/);
    expect(() => assertPriceAllowed('19.99')).toThrow(PermanentMarketplaceError);
    expect(() => assertPriceAllowed('25.01')).not.toThrow();
    expect(() => assertPriceAllowed('10000.00')).not.toThrow();
    expect(() => assertPriceAllowed('10000.01')).toThrow(/10,000/);
  });

  it('builds a create body', () => {
    const body = toGxRequest(product(), request(), account, {
      categoryId: '59',
      conditionId: '4',
      publishImmediately: true,
    });

    expect(body).toMatchObject({
      title: 'Mark I Tine Assembly',
      brand: 'Rhodes',
      categoryId: 59,
      conditionId: 4,
      price: 45,
      productId: '11111111-1111-1111-1111-111111111111',
      sku: 'RHD-TINE-01',
      shippingAllowed: true,
      shippingCost: 12.5,
      returnPolicyDays: 7,
      localPickupAllowed: false,
      acceptsOffers: false,
      madeYear: 1977,
      publishImmediately: true,
    });
    expect(body['description']).toBe('Original tine.\n\n- Tested\n- Clean');
  });

  it('lets listing overrides beat account settings', () => {
    const body = toGxRequest(
      product(),
      request({ extraParams: { gx_shipping_cost: '0', gx_accepts_offers: 'true', gx_min_offer: '40' } }),
      account,
      { categoryId: '59', conditionId: '4' },
    );
    expect(body['shippingCost']).toBe(0);
    expect(body['acceptsOffers']).toBe(true);
    expect(body['minOffer']).toBe(40);
    expect(body).not.toHaveProperty('publishImmediately');
  });

  it('lists pickup-only without a shipping cost', () => {
    const body = toGxRequest(
      product(),
      request({ extraParams: { gx_delivery: 'pickup' } }),
      { sync_settings: { gx_return_policy_days: '7' } },
      { categoryId: '1', conditionId: '1' },
    );
    expect(body['shippingAllowed']).toBe(false);
    expect(body['localPickupAllowed']).toBe(true);
    expect(body).not.toHaveProperty('shippingCost');
  });

  it('offers ship-or-pickup when asked', () => {
    const body = toGxRequest(product(), request({ extraParams: { gx_delivery: 'both' } }), account, {
      categoryId: '1',
      conditionId: '1',
    });
    expect(body).toMatchObject({ shippingAllowed: true, localPickupAllowed: true, shippingCost: 12.5 });
  });

  it('names every missing requirement at once', () => {
    expect(() =>
      toGxRequest(product({ brand: null, description: null }), request({ imageUrls: [] }), { sync_settings: {} }, {
        categoryId: '1',
        conditionId: '1',
      }),
    ).toThrow(/brand.*description.*image.*shipping cost.*return policy/);
  });

  it('caps images at 25', () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://cdn.example/${i}.jpg`);
    const body = toGxRequest(product(), request({ imageUrls: urls }), account, { categoryId: '1', conditionId: '1' });
    expect((body['imageUrls'] as string[]).length).toBe(25);
  });
});

describe('Gear Exchange category configuration', () => {
  it('prefers the listing override, then the type map, then the fallback', () => {
    const acct = { sync_settings: { gx_category_map: { parts: '120' }, gx_default_category: '7' } };
    expect(configuredCategoryFor(acct, { category: 'Parts' }, '99')).toBe('99');
    expect(configuredCategoryFor(acct, { category: 'Parts' }, null)).toBe('120');
    expect(configuredCategoryFor(acct, { category: 'Keyboards' }, null)).toBe('7');
    expect(configuredCategoryFor({ sync_settings: {} }, { category: 'Parts' }, null)).toBeNull();
  });
});

describe('Gear Exchange order mapper', () => {
  const dto = {
    orderId: 789,
    listingId: 123456,
    productId: '11111111-1111-1111-1111-111111111111',
    status: 'Awaiting Shipping',
    listedPrice: '40.00',
    soldPrice: '35.00',
    shippingAmount: '5.00',
    taxAmount: '3.80',
    totalAmount: '43.80',
    soldAt: '2024-11-21T10:01:05+00:00',
    shippingInfo: {
      ship_to_address: {
        addressLineOne: '123 Main Street',
        addressLineTwo: '',
        city: 'Los Angeles',
        state: 'CA',
        postalCode: '90012',
        country: 'US',
      },
    },
    buyerInfo: { buyer_first_name: 'Test', buyer_last_name: 'Buyer', buyer_id: 12345 },
  };

  it('maps a single-unit order at the sold price', () => {
    const order = toImportedOrder(dto, { productId: 'p1', sku: 'RHD-TINE-01', title: 'Tine' })!;
    expect(order.externalOrderId).toBe('789');
    expect(order.lineItems).toEqual([
      {
        productId: 'p1',
        externalListingId: '123456',
        sku: 'RHD-TINE-01',
        title: 'Tine',
        quantity: 1,
        unitPrice: '35.00',
        lineTotal: '35.00',
      },
    ]);
    expect(order.totalAmount).toBe('43.80');
    expect(order.shippingAddress?.line2).toBeNull();
    expect(order.buyerInfo?.externalBuyerId).toBe('12345');
    expect(order.createdAt).toBe('2024-11-21T10:01:05.000Z');
  });

  it('only trusts a real UUID as our product id', () => {
    expect(gearlineProductId({ productId: 'external-listing-id-6789' })).toBeNull();
    expect(gearlineProductId({ productId: '11111111-1111-1111-1111-111111111111' })).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
  });

  it('recognises cancelled and refunded orders', () => {
    expect(isDeadOrder({ status: 'Canceled' })).toBe(true);
    expect(isDeadOrder({ status: 'Refund Completed' })).toBe(true);
    expect(isDeadOrder({ status: 'Awaiting Shipping' })).toBe(false);
  });

  it('drops an order with no id', () => {
    expect(toImportedOrder({ ...dto, orderId: undefined })).toBeNull();
  });
});

describe('Gear Exchange client helpers', () => {
  it('unwraps both envelope and bare listing responses', () => {
    expect(unwrapListing({ message: 'ok', listing: { id: 5 } }).id).toBe(5);
    expect(unwrapListing({ id: 6, status: 'published' }).id).toBe(6);
  });

  it('normalises option lists of every plausible shape', () => {
    expect(normaliseOptions([{ id: 3, name: 'Mint' }])).toEqual([{ id: '3', name: 'Mint' }]);
    expect(normaliseOptions({ data: [{ value: 'hyperwallet', label: 'Hyperwallet' }] })).toEqual([
      { id: 'hyperwallet', name: 'Hyperwallet' },
    ]);
    expect(normaliseOptions([7, 14, 30])).toEqual([
      { id: '7', name: '7' },
      { id: '14', name: '14' },
      { id: '30', name: '30' },
    ]);
    expect(normaliseOptions({ '3': 'Mint' })).toEqual([{ id: '3', name: 'Mint' }]);
  });

  it('reads lists wrapped in a key named after the resource', () => {
    expect(normaliseOptions({ conditions: [{ id: 3, name: 'Mint' }, { id: 1, name: 'Good' }] })).toEqual([
      { id: '3', name: 'Mint' },
      { id: '1', name: 'Good' },
    ]);
    expect(normaliseOptions({ data: { '3': 'Mint' } })).toEqual([{ id: '3', name: 'Mint' }]);
    expect(normaliseOptions({ Mint: 3 })).toEqual([{ id: '3', name: 'Mint' }]);
    expect(normaliseOptions({ '3': { name: 'Mint' } })).toEqual([{ id: '3', name: 'Mint' }]);
  });

  it('flattens category trees into Parent > Child names', () => {
    expect(
      normaliseOptions({
        categories: [{ id: 1, name: 'Keyboards', children: [{ id: 59, name: 'Electric Pianos' }] }],
      }),
    ).toEqual([
      { id: '1', name: 'Keyboards' },
      { id: '59', name: 'Keyboards > Electric Pianos' },
    ]);
  });

  it('treats the image-processing block as retryable', () => {
    expect(isImageProcessingLock(new PermanentMarketplaceError('x', 409))).toBe(true);
    expect(
      isImageProcessingLock(new PermanentMarketplaceError('x', 400, '{"message":"Images are still processing"}')),
    ).toBe(true);
    expect(isImageProcessingLock(new PermanentMarketplaceError('x', 422, '{"message":"brand required"}'))).toBe(false);
  });

  it('explains 422 validation errors in one sentence', () => {
    const err = new PermanentMarketplaceError(
      'raw',
      422,
      JSON.stringify({ message: 'The brand field is required. (and 1 more error)', errors: { brand: ['The brand field is required.'], title: ['The title field is required.'] } }),
    );
    expect(explainError(err)).toBe(
      'Gear Exchange rejected the listing: The brand field is required. The title field is required.',
    );
  });
});

describe('Marketplace eligibility', () => {
  const gx = { marketplace_type: 'GEAR_EXCHANGE' as const, sync_settings: { excluded_product_types: ['t-shirt'] } };
  const reverb = { marketplace_type: 'REVERB' as const, sync_settings: {} };

  it('keeps a product type off an account that excludes it, and only that account', () => {
    const shirt = product({ category: 'T-Shirt' });
    expect(checkEligibility(shirt, gx).eligible).toBe(false);
    expect(checkEligibility(shirt, reverb).eligible).toBe(true);
  });

  it('honours per-marketplace exclusion', () => {
    const p = product({ excluded_marketplaces: ['GEAR_EXCHANGE'] });
    expect(checkEligibility(p, gx).reason).toBe('Product is excluded from Gear Exchange');
    expect(checkEligibility(p, reverb).eligible).toBe(true);
  });

  it('lets the global exclusion win', () => {
    expect(checkEligibility(product({ marketplace_excluded: true }), reverb).eligible).toBe(false);
  });
});
