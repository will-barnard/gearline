import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarketplaceAccountRow, MarketplaceListingRow, ProductRow } from '../src/db/types.js';
import { PermanentMarketplaceError, type PublishListingRequest } from '../src/marketplace/types.js';

/**
 * Connector-level behaviour of "relist after a sale", with the database, the
 * Reverb client and the job queue replaced by fakes. The point is the DECISIONS:
 * when a sale queues a relist, what SKU and history the new listing carries, and
 * that an order for the relisted unit finds its product.
 */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  enqueue: vi.fn(),
  updateInventory: vi.fn(),
  getListing: vi.fn(),
  createListing: vi.fn(),
  getOrder: vi.fn(),
  findListingBySku: vi.fn(),
  updateListing: vi.fn(),
}));

vi.mock('../src/db/index.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'selectAll', 'where']) b[m] = () => b;
    b['execute'] = async () => h.tables[table] ?? [];
    b['executeTakeFirst'] = async () => (h.tables[table] ?? [])[0];
    return b;
  };
  return { db: { selectFrom: (t: string) => builder(t) }, sql: () => ({}) };
});
vi.mock('../src/queue/sync-job-producer.js', () => ({ enqueue: h.enqueue }));
vi.mock('../src/marketplace/reverb/auth-provider.js', () => ({
  reverbAuthProvider: { areCredentialsValid: async () => true },
}));
vi.mock('../src/marketplace/reverb/conditions.js', () => ({ resolveConditionUuid: async () => 'cond-uuid' }));
vi.mock('../src/marketplace/reverb/categories.js', () => ({
  configuredCategoryFor: () => 'Parts',
  resolveCategoryUuid: async () => 'cat-uuid',
}));
vi.mock('../src/marketplace/reverb/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/marketplace/reverb/client.js')>();
  return {
    ...actual,
    updateInventory: h.updateInventory,
    getListing: h.getListing,
    createListing: h.createListing,
    getOrder: h.getOrder,
    findListingBySku: h.findListingBySku,
    updateListing: h.updateListing,
  };
});

import { reverbConnector } from '../src/marketplace/reverb/connector.js';

const account = { id: 'acct-1', marketplace_type: 'REVERB', sync_settings: {} } as unknown as MarketplaceAccountRow;

const product = {
  id: 'prod-1',
  sku: 'CLAV-D6-FRAME',
  title: 'Clavinet D6 Control Frame',
  price: '85.00',
  quantity: 0,
  special_order_quantity: 2,
  condition: 'EXCELLENT',
  image_urls: [],
} as unknown as ProductRow;

const listingRow = (external: string, metadata: Record<string, unknown> = {}) =>
  ({
    id: 'listing-1',
    product_id: 'prod-1',
    marketplace_account_id: 'acct-1',
    marketplace_type: 'REVERB',
    external_listing_id: external,
    marketplace_metadata: metadata,
  }) as unknown as MarketplaceListingRow;

const request = {
  titleOverride: null,
  descriptionOverride: null,
  priceOverride: null,
  quantity: 2,
  imageUrls: [],
  categoryId: null,
  conditionMapping: null,
  shippingDetails: null,
  extraParams: {},
} as unknown as PublishListingRequest;

/** What Reverb reports for a listing. */
const dto = (state: string, condition: string, id = '100') => ({
  id,
  state: { slug: state },
  condition: { slug: condition },
  inventory: { total: 1 },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.tables = {};
});

describe('syncInventory after a sale', () => {
  it('queues a relist when a sold used-condition listing cannot be restocked', async () => {
    h.updateInventory.mockResolvedValue(dto('sold', 'excellent'));

    const result = await reverbConnector.syncInventory(account, listingRow('100'), 2);

    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]?.[0]).toMatchObject({
      jobType: 'LISTING_PUBLISH',
      marketplaceType: 'REVERB',
      listingId: 'listing-1',
      productId: 'prod-1',
      idempotencyKey: 'reverb-relist-listing-1-100',
      payload: { reason: 'reverb_relist_after_sale', soldListingId: '100' },
    });
    // Nothing is for sale on the locked listing, and the column should say so.
    expect(result).toMatchObject({ success: true, quantitySynced: 0 });
  });

  it('also relists when Reverb rejects the inventory update outright', async () => {
    h.updateInventory.mockRejectedValue(new PermanentMarketplaceError('cannot update sold listing', 422));
    h.getListing.mockResolvedValue(dto('ordered', 'excellent'));

    const result = await reverbConnector.syncInventory(account, listingRow('100'), 2);

    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('leaves a restockable listing alone — Reverb relists Brand New / B-Stock itself', async () => {
    h.updateInventory.mockResolvedValue(dto('live', 'brand-new'));

    const result = await reverbConnector.syncInventory(account, listingRow('100'), 2);

    expect(h.enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, quantitySynced: 2 });
  });

  it('does not relist a listing that was ended, only report the failure', async () => {
    h.updateInventory.mockRejectedValue(new PermanentMarketplaceError('listing has ended', 422));
    h.getListing.mockResolvedValue(dto('ended', 'excellent'));

    const result = await reverbConnector.syncInventory(account, listingRow('100'), 2);

    expect(h.enqueue).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('listing has ended');
  });

  it('does not relist when nothing is left for sale', async () => {
    h.updateInventory.mockResolvedValue(dto('sold', 'excellent'));

    await reverbConnector.syncInventory(account, listingRow('100'), 0);

    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('lets a retryable error propagate to the retry ladder', async () => {
    h.updateInventory.mockRejectedValue(new Error('socket hang up'));

    await expect(reverbConnector.syncInventory(account, listingRow('100'), 2)).rejects.toThrow('socket hang up');
  });
});

describe('publishListing as a relist', () => {
  beforeEach(() => {
    h.createListing.mockResolvedValue({ id: '200', state: { slug: 'live' }, price: { amount: '85.00' } });
  });

  it('creates a new listing under a suffixed SKU and keeps the sold id', async () => {
    h.tables['marketplace_listings'] = [listingRow('100')];
    h.getListing.mockResolvedValue(dto('sold', 'excellent'));

    const result = await reverbConnector.publishListing(account, product, request);

    expect(h.createListing.mock.calls[0]?.[1]).toMatchObject({ sku: 'CLAV-D6-FRAME-R1' });
    expect(result).toMatchObject({ success: true, externalListingId: '200' });
    expect(result.rawMetadata).toMatchObject({
      reverb_previous_listing_ids: ['100'],
      reverb_sku: 'CLAV-D6-FRAME-R1',
    });
  });

  it('numbers the next relist and keeps the whole history, newest first', async () => {
    h.tables['marketplace_listings'] = [listingRow('200', { reverb_previous_listing_ids: ['100'] })];
    h.getListing.mockResolvedValue(dto('sold', 'excellent', '200'));
    h.createListing.mockResolvedValue({ id: '300', state: { slug: 'live' } });

    const result = await reverbConnector.publishListing(account, product, request);

    expect(h.createListing.mock.calls[0]?.[1]).toMatchObject({ sku: 'CLAV-D6-FRAME-R2' });
    expect(result.rawMetadata?.['reverb_previous_listing_ids']).toEqual(['200', '100']);
  });

  it('is an ordinary publish when there is no row yet — no extra Reverb call, product SKU', async () => {
    await reverbConnector.publishListing(account, product, request);

    expect(h.getListing).not.toHaveBeenCalled();
    expect(h.createListing.mock.calls[0]?.[1]).toMatchObject({ sku: 'CLAV-D6-FRAME' });
  });

  it('is an ordinary publish when the row\'s listing is still live', async () => {
    h.tables['marketplace_listings'] = [listingRow('100')];
    h.getListing.mockResolvedValue(dto('live', 'excellent'));

    const result = await reverbConnector.publishListing(account, product, request);

    expect(h.createListing.mock.calls[0]?.[1]).toMatchObject({ sku: 'CLAV-D6-FRAME' });
    expect(result.rawMetadata?.['reverb_sku']).toBeUndefined();
  });

  it('adopts by the RELIST sku if that one collides, and still retires the sold listing', async () => {
    h.tables['marketplace_listings'] = [listingRow('100')];
    h.getListing.mockResolvedValue(dto('sold', 'excellent'));
    h.createListing.mockRejectedValue(new PermanentMarketplaceError('SKU already exists in your shop', 422));
    h.findListingBySku.mockResolvedValue({ id: '250', sku: 'CLAV-D6-FRAME-R1', state: { slug: 'draft' } });
    h.updateListing.mockResolvedValue({ id: '250', state: { slug: 'draft' } });

    const result = await reverbConnector.publishListing(account, product, request);

    expect(h.findListingBySku).toHaveBeenCalledWith(account, 'CLAV-D6-FRAME-R1');
    expect(h.updateListing.mock.calls[0]?.[2]).toMatchObject({ sku: 'CLAV-D6-FRAME-R1' });
    expect(result).toMatchObject({ success: true, externalListingId: '250' });
    expect(result.rawMetadata).toMatchObject({
      reverb_previous_listing_ids: ['100'],
      reverb_sku: 'CLAV-D6-FRAME-R1',
    });
  });
});

describe('importOrder for a relisted unit', () => {
  const orderDto = (listingId: string, sku: string) => ({
    order_id: 9001,
    buyer_name: 'Jane Smith',
    amount_product: { amount: '85.00', currency: 'USD' },
    amount_shipping: { amount: '10.00', currency: 'USD' },
    amount_tax: { amount: '0.00', currency: 'USD' },
    amount_total: { amount: '95.00', currency: 'USD' },
    created_at: '2026-11-16T12:00:00Z',
    _links: { web: { href: 'https://reverb.com/my/selling/orders/9001' } },
    listing: { id: listingId, sku, title: 'Clavinet D6 Control Frame' },
    quantity: 1,
  });

  beforeEach(() => {
    h.tables['marketplace_listings'] = [listingRow('200', { reverb_previous_listing_ids: ['100'] })];
    h.tables['products'] = [{ id: 'prod-1', sku: 'CLAV-D6-FRAME' }];
  });

  it('maps the relist SKU back to the product by listing id', async () => {
    h.getOrder.mockResolvedValue(orderDto('200', 'CLAV-D6-FRAME-R1'));

    const order = await reverbConnector.importOrder(account, '9001');

    expect(order?.lineItems[0]).toMatchObject({ productId: 'prod-1', sku: 'CLAV-D6-FRAME', externalListingId: '200' });
  });

  it('still finds the product for an order on an earlier, retired listing', async () => {
    h.getOrder.mockResolvedValue(orderDto('100', 'CLAV-D6-FRAME'));

    const order = await reverbConnector.importOrder(account, '9001');

    expect(order?.lineItems[0]).toMatchObject({ productId: 'prod-1' });
  });

  it('leaves an order for a listing Gearline does not track exactly as Reverb sent it', async () => {
    h.getOrder.mockResolvedValue(orderDto('999', 'SOMETHING-ELSE'));

    const order = await reverbConnector.importOrder(account, '9001');

    expect(order?.lineItems[0]).toMatchObject({ productId: null, sku: 'SOMETHING-ELSE' });
  });
});
