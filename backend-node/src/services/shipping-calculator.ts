import type { ProductRow } from '../db/types.js';
import {
  ceilingToMultiple,
  decimalToString,
  multiplyDecimal,
  parseDecimal,
  setScaleHalfUp,
  tryParseDecimal,
} from '../util/decimal.js';

/**
 * Port of ShippingCalculator.
 *
 * All arithmetic runs through the BigInt decimal helpers rather than JS numbers.
 * These values are sent to eBay and Reverb as package weights and declared
 * insurance values, so a float rounding artefact would show up as a wrong
 * shipping quote on a live listing.
 */

const KG_TO_OZ = parseDecimal('35.27396');
const INSURANCE_INCREMENT = 1000n;
const SCALE = 3;

export interface ShippingDetails {
  /** Package weight in ounces. */
  weightOz: string | null;
  /** Package dimensions in inches. */
  lengthIn: string | null;
  widthIn: string | null;
  heightIn: string | null;
  /** Reverb seller shipping profile ID. eBay uses a policy ID via extraParams. */
  shippingProfileName: string | null;
  /** Declared value, rounded up to the nearest $1,000 tier. */
  insuranceValueUsd: string | null;
}

export function kgToOz(kg: string | null): string | null {
  const parsed = tryParseDecimal(kg);
  if (!parsed) return null;
  return decimalToString(setScaleHalfUp(multiplyDecimal(parsed, KG_TO_OZ), SCALE));
}

/**
 * Rounds a declared value UP to the next $1,000 tier.
 *
 *   $999   → $1,000
 *   $1,000 → $1,000   (exact multiples do not jump a tier)
 *   $1,001 → $2,000
 *   $2,400 → $3,000
 *
 * Note the exact-multiple case: ceiling division must not push $1,000 to $2,000.
 */
export function calculateInsuranceValue(price: string | null): string {
  const parsed = tryParseDecimal(price);
  if (!parsed || parsed.unscaled <= 0n) return '0';
  return decimalToString(ceilingToMultiple(parsed, INSURANCE_INCREMENT));
}

/**
 * Resolves shipping parameters from product physical data plus listing overrides.
 *
 * Override keys consumed here:
 *   weight_oz_override            — explicit imperial weight, skips kg→oz
 *   reverb_shipping_profile_name  — Reverb seller profile ID
 *
 * eBay keys are deliberately NOT consumed — they pass through to extraParams and
 * are read directly by the eBay connector.
 */
export function resolveShipping(
  product: ProductRow,
  overrides: Record<string, unknown>,
): ShippingDetails {
  const weightOverride = tryParseDecimal(overrides['weight_oz_override']);
  const weightOz = weightOverride
    ? decimalToString(weightOverride)
    : kgToOz(product.weight_kg);

  const profileRaw = overrides['reverb_shipping_profile_name'];
  const shippingProfileName = typeof profileRaw === 'string' ? profileRaw : null;

  return {
    weightOz,
    // Dimensions are stored in inches already (V16 renamed the _cm columns);
    // no conversion, despite the class name suggesting otherwise.
    lengthIn: product.dim_length_in,
    widthIn: product.dim_width_in,
    heightIn: product.dim_height_in,
    shippingProfileName,
    insuranceValueUsd: calculateInsuranceValue(product.price),
  };
}
