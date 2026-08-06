/**
 * Decimal helpers backed by native BigInt, standing in for java.math.BigDecimal.
 *
 * Why not just use JS numbers: prices are NUMERIC(10,2) and adjustment percents
 * are NUMERIC(7,4). Doing `2400 * 1.155` in IEEE-754 doubles yields
 * 2771.9999999999995, which rounds to a different cent than Java's BigDecimal
 * arithmetic. That difference gets published to live listings, so the money path
 * has to be exact.
 *
 * Representation: a scaled integer (BigInt) plus a scale, exactly like
 * BigDecimal's unscaled-value/scale pair. Only the operations the port actually
 * needs are implemented — this is not a general-purpose decimal library.
 */

export interface Decimal {
  /** Unscaled value: the digits with the point removed. */
  readonly unscaled: bigint;
  /** Number of digits after the decimal point. */
  readonly scale: number;
}

const DIGITS = /^[+-]?\d+(\.\d+)?$/;

export function parseDecimal(value: string | number): Decimal {
  const text = typeof value === 'number' ? String(value) : value.trim();

  if (!DIGITS.test(text)) {
    throw new Error(`Not a valid decimal: "${text}"`);
  }

  const [intPart = '0', fracPart = ''] = text.split('.');
  const negative = intPart.startsWith('-');
  const digits = `${intPart.replace(/^[+-]/, '')}${fracPart}`;
  const unscaled = BigInt(digits) * (negative ? -1n : 1n);

  return { unscaled, scale: fracPart.length };
}

export function tryParseDecimal(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    return parseDecimal(value);
  } catch {
    return null;
  }
}

function rescale(d: Decimal, targetScale: number): Decimal {
  if (targetScale === d.scale) return d;
  if (targetScale > d.scale) {
    return { unscaled: d.unscaled * 10n ** BigInt(targetScale - d.scale), scale: targetScale };
  }
  // Narrowing scale here would lose digits; callers must round explicitly.
  throw new Error('rescale cannot reduce scale — use setScaleHalfUp');
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { unscaled: rescale(a, scale).unscaled + rescale(b, scale).unscaled, scale };
}

export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  return { unscaled: a.unscaled * b.unscaled, scale: a.scale + b.scale };
}

/**
 * Rounds to `targetScale` using HALF_UP — ties go away from zero.
 *
 * This is RoundingMode.HALF_UP, which is what the Java code asks for
 * explicitly. It is NOT JS `Math.round` (which is half-up only for positives,
 * half-ceiling for negatives) and NOT `toFixed` (which is subject to the very
 * float representation errors we are avoiding).
 */
export function setScaleHalfUp(d: Decimal, targetScale: number): Decimal {
  if (targetScale >= d.scale) return rescale(d, targetScale);

  const dropped = d.scale - targetScale;
  const divisor = 10n ** BigInt(dropped);
  const negative = d.unscaled < 0n;
  const magnitude = negative ? -d.unscaled : d.unscaled;

  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;

  // Round away from zero when the dropped fraction is >= 0.5.
  const roundUp = remainder * 2n >= divisor;
  const rounded = roundUp ? quotient + 1n : quotient;

  return { unscaled: negative ? -rounded : rounded, scale: targetScale };
}

/**
 * Rounds UP to the next multiple of `increment` (RoundingMode.CEILING on the
 * quotient). Used for the $1,000 insurance tiers.
 */
export function ceilingToMultiple(d: Decimal, increment: bigint): Decimal {
  if (d.unscaled <= 0n) return { unscaled: 0n, scale: 0 };

  // Compare like with like: scale the increment up to the value's own scale.
  const incScaled = increment * 10n ** BigInt(d.scale);

  // Ceiling division. The `- 1n` is what keeps an exact multiple on its own
  // tier: $1,000 must stay $1,000 rather than jumping to $2,000.
  const tiers = (d.unscaled + incScaled - 1n) / incScaled;
  return { unscaled: tiers * increment, scale: 0 };
}

export function decimalToString(d: Decimal): string {
  const negative = d.unscaled < 0n;
  const digits = (negative ? -d.unscaled : d.unscaled).toString().padStart(d.scale + 1, '0');

  const intPart = digits.slice(0, digits.length - d.scale) || '0';
  const fracPart = d.scale > 0 ? digits.slice(digits.length - d.scale) : '';

  const body = d.scale > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${body}` : body;
}

export function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale).unscaled;
  const right = rescale(b, scale).unscaled;
  return left < right ? -1 : left > right ? 1 : 0;
}

export const ZERO: Decimal = { unscaled: 0n, scale: 0 };
export const ONE: Decimal = { unscaled: 1n, scale: 0 };

/**
 * Divides two integers with HALF_UP rounding, producing a value at
 * `targetScale`. Equivalent to BigDecimal.divide(divisor, scale, HALF_UP).
 *
 * Sign is handled by taking magnitudes and reapplying it, so that HALF_UP
 * rounds away from zero on negatives too (-0.125 → -0.13). Doing the division
 * on signed BigInts would truncate toward zero and round the wrong way.
 */
export function divideHalfUp(numerator: bigint, denominator: bigint, targetScale: number): Decimal {
  if (denominator === 0n) throw new Error('Division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const scaled = n * 10n ** BigInt(targetScale);
  const quotient = scaled / d;
  const remainder = scaled % d;

  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return { unscaled: negative ? -rounded : rounded, scale: targetScale };
}

/**
 * finalPrice = base × (1 + adjustmentPercent / 100), rounded HALF_UP to 2dp.
 *
 * Mirrors SyncDispatcherService.applyPricingProfile, including its intermediate
 * scale of 10 on the division:
 *
 *     adjustmentPercent.divide(BigDecimal.valueOf(100), 10, RoundingMode.HALF_UP)
 *
 * That intermediate scale is observable rather than incidental. A percentage
 * with a long decimal expansion (33.3333%) rounds differently if the factor is
 * computed at a lower scale, and the result is a published price — so the scale
 * is reproduced exactly rather than simplified away.
 *
 * Verified against the Java behaviour for the tie-breaking and negative cases
 * in test/decimal.test.ts.
 */
export function applyPercentageAdjustment(base: string, adjustmentPercent: string): string {
  const basePrice = parseDecimal(base);
  const percent = parseDecimal(adjustmentPercent);

  // percent / 100, at scale 10, HALF_UP.
  // percent's own value is percent.unscaled / 10^percent.scale, so dividing by
  // 100 means a denominator of 10^scale * 100.
  const fraction = divideHalfUp(percent.unscaled, 10n ** BigInt(percent.scale) * 100n, 10);

  const factor = addDecimal(ONE, fraction);
  return decimalToString(setScaleHalfUp(multiplyDecimal(basePrice, factor), 2));
}
