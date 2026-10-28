import { describe, expect, it } from 'vitest';

import {
  dimensionPatch,
  parseDimension,
  patchIsNoop,
} from '../src/marketplace/shopify/variant-dimensions.js';

describe('parseDimension', () => {
  it.each([
    ['54', '54'],
    ['54.0', '54.0'],
    [' 12.5 ', '12.5'],
  ])('accepts %j', (value, expected) => {
    expect(parseDimension(value)).toBe(expected);
  });

  it.each([[''], ['   '], ['54 in'], ['54"'], ['abc'], [null], [undefined], [54]])(
    'rejects %j',
    (value) => {
      expect(parseDimension(value)).toBeNull();
    },
  );
});

describe('dimensionPatch', () => {
  it('keeps only usable dimension keys', () => {
    expect(
      dimensionPatch({
        dim_length_in: '58',
        dim_width_in: '16 in',
        dim_height_in: undefined,
        reverb_model: 'Mark I',
      }),
    ).toEqual({ dim_length_in: '58' });
  });

  it('returns an empty patch when nothing is set', () => {
    expect(dimensionPatch({})).toEqual({});
  });
});

describe('patchIsNoop', () => {
  it('treats numerically equal values as unchanged', () => {
    expect(patchIsNoop({ dim_length_in: '58.000' }, { dim_length_in: '58' })).toBe(true);
  });

  it('detects a change', () => {
    expect(patchIsNoop({ dim_length_in: '48.000' }, { dim_length_in: '58' })).toBe(false);
  });

  it('treats a missing current value as a change', () => {
    expect(patchIsNoop({ dim_length_in: null }, { dim_length_in: '58' })).toBe(false);
  });
});
