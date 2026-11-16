import { describe, expect, it } from 'vitest';

import type { ProductRow } from '../src/db/types.js';
import { toReverbRequest } from '../src/marketplace/reverb/listing-mapper.js';
import {
  allListingIds,
  isLockedBySale,
  isSingleUnitCondition,
  needsRelist,
  previousListingIds,
  relistSku,
} from '../src/marketplace/reverb/relist.js';
import type { PublishListingRequest } from '../src/marketplace/types.js';

describe('needsRelist', () => {
  const sold = (conditionSlug: string | null, state: string | null = 'sold') => ({ state, conditionSlug });

  it('relists a sold used-condition listing when more units are for sale', () => {
    // The Clavinet frame: Excellent, locked "Ordered" after its first sale.
    expect(needsRelist(sold('excellent'), 2)).toBe(true);
    expect(needsRelist(sold('very-good', 'ordered'), 1)).toBe(true);
  });

  it('does nothing when no more units are for sale — the delist owns that case', () => {
    expect(needsRelist(sold('excellent'), 0)).toBe(false);
  });

  it('never relists a multi-unit condition — Reverb restocks those itself', () => {
    expect(needsRelist(sold('brand-new'), 2)).toBe(false);
    expect(needsRelist(sold('b-stock'), 2)).toBe(false);
  });

  it('never relists on an unrecognised or missing condition (no accidental duplicates)', () => {
    expect(needsRelist(sold('mint-with-inventory'), 2)).toBe(false);
    expect(needsRelist(sold(null), 2)).toBe(false);
  });

  it('leaves live, draft and ended listings alone — ended may be deliberate', () => {
    for (const state of ['live', 'draft', 'ended', 'suspended', null]) {
      expect(needsRelist(sold('excellent', state), 2)).toBe(false);
    }
  });
});

describe('state and condition predicates', () => {
  it('is case-insensitive', () => {
    expect(isLockedBySale('SOLD')).toBe(true);
    expect(isSingleUnitCondition('Excellent')).toBe(true);
  });
});

describe('listing id history', () => {
  const row = (external: string | null, previous?: unknown) => ({
    external_listing_id: external,
    marketplace_metadata: previous === undefined ? {} : { reverb_previous_listing_ids: previous },
  });

  it('reads the retired ids, tolerating bad metadata', () => {
    expect(previousListingIds(row('2', ['1']) as never)).toEqual(['1']);
    expect(previousListingIds(row('2', 'nope') as never)).toEqual([]);
    expect(previousListingIds(undefined)).toEqual([]);
  });

  it('allListingIds is the current id plus every retired one', () => {
    expect(allListingIds(row('3', ['2', '1']) as never)).toEqual(['3', '2', '1']);
    expect(allListingIds(row(null, ['1']) as never)).toEqual(['1']);
  });
});

describe('relistSku', () => {
  it('numbers each relist from the count of sold listings', () => {
    expect(relistSku('CLAV-D6-FRAME', ['100'])).toBe('CLAV-D6-FRAME-R1');
    expect(relistSku('CLAV-D6-FRAME', ['200', '100'])).toBe('CLAV-D6-FRAME-R2');
  });
});

describe('toReverbRequest sku option', () => {
  const product = { id: 'p', sku: 'CLAV-D6-FRAME', title: 'Frame', price: '50.00', quantity: 2 } as unknown as ProductRow;
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
  const base = { conditionUuid: 'c', categoryUuid: 'k' };

  it('defaults to the product SKU', () => {
    expect(toReverbRequest(product, request, base)['sku']).toBe('CLAV-D6-FRAME');
  });

  it('sends the relist SKU when given', () => {
    expect(toReverbRequest(product, request, { ...base, sku: 'CLAV-D6-FRAME-R1' })['sku']).toBe('CLAV-D6-FRAME-R1');
  });
});
