/**
 * Per-variant package dimensions.
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
