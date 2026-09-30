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

describe('Reverb order money', () => {
  const money = (amount: string) => ({ amount, currency: 'USD' });

  it('reads the list-style amount_* fields', () => {
    const r = toImportedOrder({
      ...base,
      amount_product: money('3675.00'),
      amount_shipping: money('50.00'),
      amount_tax: money('10.00'),
      amount_total: money('3735.00'),
    });
    expect([r?.subtotal, r?.shippingTotal, r?.taxTotal, r?.totalAmount]).toEqual([
      '3675.00', '50.00', '10.00', '3735.00',
    ]);
  });

  it('reads the single-order total and shipping fields (was importing as $0.00)', () => {
    const r = toImportedOrder({
      ...base,
      amount_product: money('3675.00'),
      shipping: money('0.00'),
      amount_tax: money('0.00'),
      total: money('3675.00'),
    });
    expect(r?.totalAmount).toBe('3675.00');
    expect(r?.shippingTotal).toBe('0.00');
  });

  it('computes the total from its parts when Reverb gives none', () => {
    const r = toImportedOrder({
      ...base,
      amount_product: money('3675.00'),
      amount_shipping: money('50.00'),
      amount_tax: money('10.25'),
    });
    expect(r?.totalAmount).toBe('3735.25');
  });
});
