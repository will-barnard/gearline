import { decimalToString, divideHalfUp } from '../../util/decimal.js';

/**
 * Shopify stores a variant's weight on its inventory item
 * (`InventoryItem.measurement.weight`), as a value plus a unit the merchant
 * chose. The legacy variant `grams` field the REST payload used to carry is not
 * reliable any more, so this is the source of truth.
 *
 * Grams per unit for every `WeightUnit` Shopify can return.
 */
const GRAMS_PER_UNIT: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  OUNCES: 28.349523125,
  POUNDS: 453.59237,
};

/**
 * Converts a Shopify weight to the kg string the `weight_kg` column stores
 * (scale 3, so gram precision).
 *
 * Returns null for a missing, zero, negative, non-finite or unknown-unit weight
 * — "no usable weight", which the caller treats as "leave the column alone"
 * rather than overwriting a good value with 0.
 */
export function shopifyWeightToKg(value: unknown, unit: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (typeof unit !== 'string') return null;

  const gramsPerUnit = GRAMS_PER_UNIT[unit.toUpperCase()];
  if (gramsPerUnit === undefined) return null;

  const grams = Math.round(value * gramsPerUnit);
  if (grams <= 0) return null;

  return decimalToString(divideHalfUp(BigInt(grams), 1000n, 3));
}
