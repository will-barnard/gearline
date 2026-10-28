/**
 * Per-variant package dimensions.
 *
 * Three sources, highest priority first:
 *
 *   1. Shopify's native "Packed dimensions" on the variant's inventory item
 *      (InventoryItem.measurement.packedDimensions, Admin API 2027-01+). This
 *      is the field the admin shows next to weight, and the one Shopify itself
 *      uses for package selection and rates, so it is the preferred place to
 *      enter a box size.
 *   2. Variant metafields custom.dim_length_in / dim_width_in / dim_height_in.
 *   3. The same metafields on the PRODUCT (applied to every variant by
 *      applyMetafields).
 *
 * Packed dimensions are all-or-nothing: Shopify returns zeros for unset
 * values, and a box with one real side and two zero sides is not a box, so
 * all three must be positive or the source is skipped entirely.
 *
 * The metafield notes below describe sources 2 and 3.
 *
 * Dimensions normally come from the PRODUCT metafields custom.dim_length_in /
 * dim_width_in / dim_height_in, which applyMetafields copies onto every variant
 * of the product. That is wrong when the variants ship in different boxes —
 * the Rhodes plexiglass lids come in 73-key and 88-key sizes, and the 88's box
 * is 54" long.
 *
 * So the same three metafields may also be set on a VARIANT, with the same
 * keys and namespace. A variant value wins over the product value. Each key is
 * independent: a variant that sets only dim_length_in keeps the product's
 * width and height. That keeps the rule easy to predict ("the variant value
 * wins if there is one") at the cost of allowing a mixed box, which is the
 * operator's call to make.
 *
 * Like product metafields, a variant value that is later deleted in Shopify is
 * not cleared here — the next sync simply stops overriding, so the product
 * value (if any) takes over again.
 *
 * Kept free of I/O so the parsing rule is unit-testable.
 */

export const DIMENSION_KEYS = ['dim_length_in', 'dim_width_in', 'dim_height_in'] as const;

export type DimensionKey = (typeof DIMENSION_KEYS)[number];

export type DimensionPatch = Partial<Record<DimensionKey, string>>;

import {
  decimalToString,
  multiplyDecimal,
  parseDecimal,
  setScaleHalfUp,
  tryParseDecimal,
} from '../../util/decimal.js';

/** Same acceptance rule the product-metafield path has always used. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Parses one dimension value. Returns the trimmed decimal string (the columns
 * are numeric and the decimal helpers expect strings), or null when the value
 * is blank or not a plain number.
 *
 * Shopify's number_decimal metafields arrive as strings like "54.0"; anything
 * with units ("54 in") is rejected rather than guessed at, because a wrong
 * dimension becomes a wrong shipping quote on a live listing.
 */
export function parseDimension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || !DECIMAL.test(trimmed)) return null;
  return trimmed;
}

/**
 * Builds a dimension patch from a variant's metafield values, keyed by
 * metafield key. Unknown keys and unusable values are ignored.
 */
export function dimensionPatch(values: Partial<Record<string, unknown>>): DimensionPatch {
  const patch: DimensionPatch = {};
  for (const key of DIMENSION_KEYS) {
    const parsed = parseDimension(values[key]);
    if (parsed !== null) patch[key] = parsed;
  }
  return patch;
}

/** True when applying `patch` to `row` would change nothing. */
export function patchIsNoop(
  row: Partial<Record<DimensionKey, unknown>>,
  patch: DimensionPatch,
): boolean {
  return (Object.keys(patch) as DimensionKey[]).every((key) => {
    const current = row[key];
    if (current === null || current === undefined) return false;
    // Postgres numeric comes back as a string, possibly with trailing zeros
    // ("54.000"), so compare as numbers rather than as text.
    return Number(current) === Number(patch[key]);
  });
}

// ── Packed dimensions (native Shopify field) ─────────────────────────────────

export interface PackedDimensions {
  length?: unknown;
  width?: unknown;
  height?: unknown;
  unit?: unknown;
}

/** 1 / 2.54, to more places than the NUMERIC(8, 2) columns can hold. */
const CM_TO_IN = parseDecimal('0.3937007874');

/** The dim_* columns are NUMERIC(8, 2). */
const COLUMN_SCALE = 2;

/** One side in inches, or null when unset (Shopify reports unset as 0). */
function toInches(value: unknown, unit: string): string | null {
  // Shopify sends Floats; a whole number arrives as 58, not "58.0".
  const parsed = tryParseDecimal(typeof value === 'number' ? String(value) : value);
  if (!parsed || parsed.unscaled <= 0n) return null;

  const inches = unit === 'CENTIMETERS' ? multiplyDecimal(parsed, CM_TO_IN) : parsed;
  return decimalToString(setScaleHalfUp(inches, COLUMN_SCALE));
}

/**
 * Converts Shopify packed dimensions into a dimension patch, in inches.
 * Returns {} unless all three sides are set and the unit is one we know —
 * an unrecognised unit is skipped rather than guessed at, since guessing cm
 * as inches would make a box 2.5x too big on a live listing.
 */
export function packedDimensionsPatch(dims: PackedDimensions | null | undefined): DimensionPatch {
  if (!dims) return {};

  const unit = typeof dims.unit === 'string' ? dims.unit.toUpperCase() : '';
  if (unit !== 'INCHES' && unit !== 'CENTIMETERS') return {};

  const length = toInches(dims.length, unit);
  const width = toInches(dims.width, unit);
  const height = toInches(dims.height, unit);

  if (length === null || width === null || height === null) return {};

  return { dim_length_in: length, dim_width_in: width, dim_height_in: height };
}
