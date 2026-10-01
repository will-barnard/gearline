import { describe, expect, it } from 'vitest';

import { shopifyWeightToKg } from '../src/marketplace/shopify/weight.js';

describe('shopifyWeightToKg', () => {
  it.each([
    [45, 'POUNDS', '20.412'],
    [1, 'POUNDS', '0.454'],
    [16, 'OUNCES', '0.454'],
    [2.5, 'KILOGRAMS', '2.500'],
    [750, 'GRAMS', '0.750'],
    [45, 'pounds', '20.412'],
  ])('%s %s -> %s kg', (value, unit, expected) => {
    expect(shopifyWeightToKg(value, unit)).toBe(expected);
  });

  it.each([
    [0, 'POUNDS'],
    [-3, 'POUNDS'],
    [Number.NaN, 'POUNDS'],
    [45, 'STONES'],
    [45, undefined],
    [undefined, 'POUNDS'],
    ['45', 'POUNDS'],
  ])('returns null for unusable weight (%s, %s)', (value, unit) => {
    expect(shopifyWeightToKg(value, unit)).toBeNull();
  });
});
