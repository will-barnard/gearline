import { describe, expect, it } from 'vitest';

import type { ImportedOrder } from '../src/marketplace/types.js';
import {
  isBehindWatermark,
  isImportCandidate,
  isInRescanWindow,
  rescanWindowStartMs,
} from '../src/marketplace/reverb/order-window.js';

const NOW = Date.parse('2026-09-30T00:00:00Z');
const SINCE = Date.parse('2026-09-29T23:15:00Z'); // last poll, 10 min ago
const WINDOW = rescanWindowStartMs(SINCE, NOW, 14);

function order(createdAt: string | null, status: string | null): ImportedOrder {
  return {
    externalOrderId: '1',
    marketplaceOrderUrl: null,
    lineItems: [],
    subtotal: '0',
    shippingTotal: '0',
    taxTotal: '0',
    totalAmount: '0',
    currency: 'USD',
    buyerInfo: null,
    shippingAddress: null,
    createdAt,
    marketplaceStatus: status,
  };
}

describe('Reverb order window', () => {
  it('uses the rescan horizon when it is older than the watermark', () => {
    expect(WINDOW).toBe(NOW - 14 * 86_400_000);
  });

  it('uses the watermark when it is older than the rescan horizon', () => {
    const oldSince = NOW - 30 * 86_400_000;
    expect(rescanWindowStartMs(oldSince, NOW, 14)).toBe(oldSince);
  });

  it('imports an order newer than the watermark regardless of status (unchanged behaviour)', () => {
    expect(isImportCandidate(order('2026-09-29T23:30:00Z', 'unpaid'), SINCE, WINDOW)).toBe(true);
  });

  it('imports a paid order created BEFORE the watermark (accepted offer paid ~20h later)', () => {
    const o = order('2026-09-29T03:20:00Z', 'paid');
    expect(isImportCandidate(o, SINCE, WINDOW)).toBe(true);
    expect(isBehindWatermark(o, SINCE)).toBe(true);
  });

  it.each(['unpaid', 'payment_pending', 'pending_review', 'blocked', 'cancelled', 'refunded', null])(
    'does not resurrect a behind-the-watermark order with status %s',
    (status) => {
      expect(isImportCandidate(order('2026-09-29T03:20:00Z', status), SINCE, WINDOW)).toBe(false);
    },
  );

  it.each(['paid', 'shipped', 'picked_up', 'received', 'PAID'])(
    'accepts paid-type status %s behind the watermark',
    (status) => {
      expect(isImportCandidate(order('2026-09-20T00:00:00Z', status), SINCE, WINDOW)).toBe(true);
    },
  );

  it('ignores orders older than the rescan window', () => {
    expect(isImportCandidate(order('2026-09-01T00:00:00Z', 'paid'), SINCE, WINDOW)).toBe(false);
  });

  it('keeps undated orders, to fail safe', () => {
    expect(isImportCandidate(order(null, 'paid'), SINCE, WINDOW)).toBe(true);
    expect(isInRescanWindow(order(null, null), WINDOW)).toBe(true);
  });

  it('tells pagination whether a row is inside the window irrespective of status', () => {
    expect(isInRescanWindow(order('2026-09-29T03:20:00Z', 'cancelled'), WINDOW)).toBe(true);
    expect(isInRescanWindow(order('2026-09-01T00:00:00Z', 'paid'), WINDOW)).toBe(false);
  });
});
