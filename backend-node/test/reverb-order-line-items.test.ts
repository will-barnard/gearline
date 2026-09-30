import { describe, expect, it } from 'vitest';

import { toImportedOrder } from '../src/marketplace/reverb/order-mapper.js';
import type { ReverbOrderDto } from '../src/marketplace/reverb/types.js';

const base: ReverbOrderDto = {
  order_id: 26545736,
  status: 'paid',
  buyer_name: 'Pat Buyer',
  amount_product: { amount: '1200.00', currency: 'USD' },
  created_at: '2026-09-29T02:42:55Z',
  quantity: 1,
};

describe('Reverb order line items', () => {
  it('prefers the nested listing object when present', () => {
    const r = toImportedOrder({ ...base, listing: { id: 'L-1', sku: 'NESTED', title: 'Nested' }, sku: 'FLAT' });
    expect(r?.lineItems).toHaveLength(1);
    expect(r?.lineItems[0]?.sku).toBe('NESTED');
  });

  it('falls back to the flat sku/title/product_id fields (local pickup order)', () => {
    const r = toImportedOrder({ ...base, sku: 'RHODES-88', title: 'Rhodes Mark I', product_id: 98765, local_pickup: true });
    expect(r?.lineItems).toEqual([
      {
        productId: null,
        externalListingId: '98765',
        sku: 'RHODES-88',
        title: 'Rhodes Mark I',
        quantity: 1,
        unitPrice: '1200.00',
        lineTotal: null,
      },
    ]);
  });

  it('takes the listing id from _links.listing when product_id is absent', () => {
    const r = toImportedOrder({
      ...base,
      sku: 'RHODES-88',
      _links: { listing: { href: 'https://api.reverb.com/api/listings/98765/' } },
    });
    expect(r?.lineItems[0]?.externalListingId).toBe('98765');
  });

  it('returns no line items when there is no SKU, so the connector skips it loudly', () => {
    expect(toImportedOrder({ ...base, sku: '   ', title: 'No sku', product_id: 1 })?.lineItems).toEqual([]);
    expect(toImportedOrder(base)?.lineItems).toEqual([]);
  });
});
