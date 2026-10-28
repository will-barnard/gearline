import { describe, expect, it } from 'vitest';

import {
  dimensionPatch,
  packedDimensionsPatch,
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

describe('packedDimensionsPatch', () => {
  it('passes inches through, rounded to the column scale', () => {
    expect(packedDimensionsPatch({ length: 58, width: 16.125, height: 4, unit: 'INCHES' })).toEqual({
      dim_length_in: '58.00',
      dim_width_in: '16.13',
      dim_height_in: '4.00',
    });
  });

  it('converts centimetres to inches', () => {
    expect(packedDimensionsPatch({ length: 137.16, width: 40.64, height: 10.16, unit: 'CENTIMETERS' })).toEqual({
      dim_length_in: '54.00',
      dim_width_in: '16.00',
      dim_height_in: '4.00',
    });
  });

  it('skips unset dimensions, which Shopify reports as zeros', () => {
    expect(packedDimensionsPatch({ length: 0, width: 0, height: 0, unit: 'INCHES' })).toEqual({});
  });

  it('skips a partial box', () => {
    expect(packedDimensionsPatch({ length: 58, width: 16, height: 0, unit: 'INCHES' })).toEqual({});
  });

  it('skips an unknown unit rather than guessing', () => {
    expect(packedDimensionsPatch({ length: 58, width: 16, height: 4, unit: 'FEET' })).toEqual({});
  });

  it('handles a missing value', () => {
    expect(packedDimensionsPatch(null)).toEqual({});
  });
});
