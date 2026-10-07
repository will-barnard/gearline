import { describe, expect, it } from 'vitest';

import {
  channelQuantity,
  DEFAULT_SPECIAL_ORDER_QUANTITY,
  isSpecialOrder,
  specialOrderQuantity,
  specialOrderQuantityFor,
  specialOrderTags,
} from '../src/services/special-order.js';

describe('specialOrderQuantityFor', () => {
  it('is null for an untagged product and for the defaults-less case', () => {
    expect(specialOrderQuantityFor('', null)).toBeNull();
    expect(specialOrderQuantityFor('piano, vintage', null)).toBeNull();
  });

  it('matches the default tag case-insensitively and ignoring whitespace', () => {
    expect(specialOrderQuantityFor('digital, Special-Order ', null)).toBe(DEFAULT_SPECIAL_ORDER_QUANTITY);
    expect(specialOrderQuantityFor('SPECIAL-ORDER', {})).toBe(DEFAULT_SPECIAL_ORDER_QUANTITY);
  });

  it('does not match a tag that merely contains the word', () => {
    expect(specialOrderQuantityFor('special-orders, not-special-order', null)).toBeNull();
  });

  it('never applies to a restoration pre-order, even if tagged both', () => {
    expect(specialOrderQuantityFor('special-order, restoration', null)).toBeNull();
  });

  it('honours configured tags and quantity from the account settings', () => {
    const settings = { special_order_tags: ['Dealer Order'], special_order_quantity: 3 };
    expect(specialOrderQuantityFor('dealer order', settings)).toBe(3);
    expect(specialOrderQuantityFor('special-order', settings)).toBeNull();
  });

  it('an empty tag list switches the feature off', () => {
    expect(specialOrderQuantityFor('special-order', { special_order_tags: [] })).toBeNull();
  });
});

describe('settings parsing', () => {
  it('falls back to defaults for missing or malformed values', () => {
    expect(specialOrderTags(null)).toEqual(['special-order']);
    expect(specialOrderTags({ special_order_tags: 'special-order' })).toEqual(['special-order']);
    expect(specialOrderQuantity(null)).toBe(2);
    expect(specialOrderQuantity({ special_order_quantity: 0 })).toBe(2);
    expect(specialOrderQuantity({ special_order_quantity: 'x' })).toBe(2);
    expect(specialOrderQuantity({ special_order_quantity: 2.5 })).toBe(2);
  });

  it('caps the quantity so a typo cannot list 5000 units', () => {
    expect(specialOrderQuantity({ special_order_quantity: 5000 })).toBe(25);
    expect(specialOrderQuantity({ special_order_quantity: 1 })).toBe(1);
  });
});

describe('channelQuantity', () => {
  it('is the real stock when there is any, special order or not', () => {
    expect(channelQuantity({ quantity: 3, special_order_quantity: null })).toBe(3);
    expect(channelQuantity({ quantity: 3, special_order_quantity: 2 })).toBe(3);
  });

  it('is the special-order quantity at zero stock', () => {
    expect(channelQuantity({ quantity: 0, special_order_quantity: 2 })).toBe(2);
  });

  it('is still zero for an ordinary product at zero stock, so it is delisted as before', () => {
    expect(channelQuantity({ quantity: 0, special_order_quantity: null })).toBe(0);
  });

  it('treats a negative stored quantity like zero', () => {
    expect(channelQuantity({ quantity: -1, special_order_quantity: 2 })).toBe(2);
    expect(channelQuantity({ quantity: -1, special_order_quantity: null })).toBe(0);
  });
});

describe('isSpecialOrder', () => {
  it('reflects whether the column is set', () => {
    expect(isSpecialOrder({ special_order_quantity: 2 })).toBe(true);
    expect(isSpecialOrder({ special_order_quantity: null })).toBe(false);
  });
});
