import { describe, expect, it } from 'vitest';

import {
  applyPercentageAdjustment,
  ceilingToMultiple,
  decimalToString,
  divideHalfUp,
  parseDecimal,
  setScaleHalfUp,
} from '../src/util/decimal.js';
import { calculateInsuranceValue, kgToOz } from '../src/services/shipping-calculator.js';

/**
 * These assert BigDecimal-equivalent behaviour. They exist because the naive
 * float implementation passes casual inspection and then publishes wrong prices
 * to live marketplace listings.
 *
 * The first version of applyPercentageAdjustment written for this port was off
 * by several orders of magnitude (2400 @ 15.5% produced 39600.00). It looked
 * fine in review; only these cases caught it.
 */

describe('applyPercentageAdjustment — pricing profiles', () => {
  it.each([
    ['2400.00', '15.5', '2772.00'],
    ['1999.99', '10', '2199.99'],
    ['100.00', '-12.5', '87.50'],
    ['0.01', '100', '0.02'],
    ['1234.56', '0', '1234.56'],
    ['99.99', '33.3333', '133.32'],
    ['500.00', '-100', '0.00'],
    ['1000.00', '1000', '11000.00'],
    ['0.05', '50', '0.08'],
  ])('%s at %s%% -> %s', (price, percent, expected) => {
    expect(applyPercentageAdjustment(price, percent)).toBe(expected);
  });

  it('avoids the float error that toFixed would introduce', () => {
    // 2400 * 1.155 in IEEE-754 is 2771.9999999999995.
    expect(applyPercentageAdjustment('2400.00', '15.5')).toBe('2772.00');
  });

  it('keeps full precision on a long percentage expansion', () => {
    // Rounding the factor at a lower intermediate scale gives 133.31 here.
    // The Java code divides at scale 10, so 133.32 is the correct answer.
    expect(applyPercentageAdjustment('99.99', '33.3333')).toBe('133.32');
  });
});

describe('setScaleHalfUp — RoundingMode.HALF_UP', () => {
  it.each([
    ['0.125', 2, '0.13'],
    ['0.135', 2, '0.14'],
    ['2.5', 0, '3'],
    ['1.4999', 0, '1'],
  ])('%s at scale %i -> %s', (value, scale, expected) => {
    expect(decimalToString(setScaleHalfUp(parseDecimal(value), scale))).toBe(expected);
  });

  it('rounds negatives AWAY from zero, not toward it', () => {
    // HALF_UP means away from zero. Math.round(-0.125*100)/100 would give -0.12.
    expect(decimalToString(setScaleHalfUp(parseDecimal('-0.125'), 2))).toBe('-0.13');
    expect(decimalToString(setScaleHalfUp(parseDecimal('-2.5'), 0))).toBe('-3');
  });
});

describe('divideHalfUp', () => {
  it('rounds the quotient half-up', () => {
    expect(decimalToString(divideHalfUp(1n, 3n, 4))).toBe('0.3333');
    expect(decimalToString(divideHalfUp(2n, 3n, 4))).toBe('0.6667');
  });

  it('rejects division by zero', () => {
    expect(() => divideHalfUp(1n, 0n, 2)).toThrow(/Division by zero/);
  });
});

describe('calculateInsuranceValue — $1,000 tiers', () => {
  it.each([
    ['999', '1000'],
    ['1000', '1000'],
    ['1001', '2000'],
    ['2400', '3000'],
    ['5000', '5000'],
  ])('$%s -> $%s', (price, expected) => {
    expect(calculateInsuranceValue(price)).toBe(expected);
  });

  it('does not push an exact multiple into the next tier', () => {
    // The classic ceiling-division off-by-one. $1,000 must stay $1,000.
    expect(calculateInsuranceValue('1000.00')).toBe('1000');
    expect(calculateInsuranceValue('2000.00')).toBe('2000');
  });

  it('returns zero for zero, negative or missing prices', () => {
    expect(calculateInsuranceValue('0')).toBe('0');
    expect(calculateInsuranceValue('-50')).toBe('0');
    expect(calculateInsuranceValue(null)).toBe('0');
  });
});

describe('ceilingToMultiple', () => {
  it('handles fractional inputs', () => {
    expect(decimalToString(ceilingToMultiple(parseDecimal('1000.01'), 1000n))).toBe('2000');
    expect(decimalToString(ceilingToMultiple(parseDecimal('999.99'), 1000n))).toBe('1000');
  });
});

describe('kgToOz', () => {
  it.each([
    ['3.5', '123.459'],
    ['1', '35.274'],
    ['0.001', '0.035'],
  ])('%s kg -> %s oz', (kg, expected) => {
    expect(kgToOz(kg)).toBe(expected);
  });

  it('returns null for a missing weight rather than zero', () => {
    // Zero would be sent to the marketplace as a real weight; null omits the
    // shipping block entirely, which is the intended behaviour.
    expect(kgToOz(null)).toBeNull();
  });
});
