package com.gearline.marketplace.common.util;

import com.gearline.domain.product.Dimensions;
import com.gearline.domain.product.Product;
import com.gearline.marketplace.common.dto.ShippingDetails;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Map;

/**
 * Computes shipping parameters from product physical data and per-listing overrides.
 *
 * Unit conversions:
 *   Weight: kilograms → ounces  (1 kg = 35.27396 oz)
 *   Length: centimetres → inches (1 cm = 0.393701 in)
 *
 * Insurance tiers:
 *   The declared package value is rounded up to the nearest $1,000 to match
 *   the tier pricing used by most shipping carriers and third-party insurer
 *   integrations (e.g. Shipstation, EasyPost). A $2,400 guitar becomes a
 *   $3,000 declared value; a $1,000 guitar stays at $1,000.
 */
@Component
@Slf4j
public class ShippingCalculator {

    private static final BigDecimal KG_TO_OZ    = new BigDecimal("35.27396");
    private static final BigDecimal CM_TO_IN     = new BigDecimal("0.393701");
    private static final BigDecimal INSURANCE_INCREMENT = new BigDecimal("1000");
    private static final int        SCALE        = 3;

    // ── Unit conversions ───────────────────────────────────────────────────────

    public BigDecimal kgToOz(BigDecimal kg) {
        if (kg == null) return null;
        return kg.multiply(KG_TO_OZ).setScale(SCALE, RoundingMode.HALF_UP);
    }

    public BigDecimal cmToIn(BigDecimal cm) {
        if (cm == null) return null;
        return cm.multiply(CM_TO_IN).setScale(SCALE, RoundingMode.HALF_UP);
    }

    // ── Insurance calculation ─────────────────────────────────────────────────

    /**
     * Rounds a declared item value up to the nearest $1,000 insurance tier.
     *
     * Examples:
     *   $999   → $1,000
     *   $1,000 → $1,000
     *   $1,001 → $2,000
     *   $2,400 → $3,000
     *   $5,000 → $5,000
     */
    public BigDecimal calculateInsuranceValue(BigDecimal price) {
        if (price == null || price.compareTo(BigDecimal.ZERO) <= 0) {
            return BigDecimal.ZERO;
        }
        // ceiling division: ⌈price / 1000⌉ * 1000
        BigDecimal tiers = price.divide(INSURANCE_INCREMENT, 0, RoundingMode.CEILING);
        return tiers.multiply(INSURANCE_INCREMENT);
    }

    // ── Composite resolver ─────────────────────────────────────────────────────

    /**
     * Resolves a complete ShippingDetails from a product's physical data plus any
     * per-listing overrides stored in {@code listing_overrides}.
     *
     * Override keys consumed from the overrides map:
     * <pre>
     *   reverb_shipping_profile_name  — Reverb seller shipping profile ID (numeric string)
     *   weight_oz_override            — explicit imperial weight in oz (skips kg→oz conversion)
     * </pre>
     * eBay-specific keys (ebay_fulfillment_policy_id, etc.) are NOT consumed here —
     * they pass through to extraParams and are read directly by EbayConnector.
     *
     * @param product   canonical product (provides weight_kg, dimensions in cm, price)
     * @param overrides listing_overrides JSONB map; may be empty but never null
     */
    public ShippingDetails resolveShipping(Product product, Map<String, Object> overrides) {
        // Weight: check for an explicit imperial override first, else convert from kg
        BigDecimal weightOz = getDecimalOverride(overrides, "weight_oz_override");
        if (weightOz == null) {
            weightOz = kgToOz(product.getWeightKg());
        }

        // Dimensions: stored in inches directly (entered by seller in Shopify as inches)
        BigDecimal lengthIn = null;
        BigDecimal widthIn  = null;
        BigDecimal heightIn = null;
        Dimensions dims = product.getDimensions();
        if (dims != null) {
            lengthIn = dims.getLengthIn();
            widthIn  = dims.getWidthIn();
            heightIn = dims.getHeightIn();
        }

        // Reverb shipping profile ID — Reverb-only concept.
        // eBay uses a fulfillment policy UUID sent separately via extraParams, not here.
        String shippingProfileName = getStringOverride(overrides, "reverb_shipping_profile_name");

        // Insurance value
        BigDecimal insuranceValue = calculateInsuranceValue(product.getPrice());

        if (weightOz == null && lengthIn == null && shippingProfileName == null) {
            log.debug("Product {} has no weight, dimensions, or shipping profile — shipping block will be omitted",
                product.getSku());
        }

        return ShippingDetails.builder()
            .weightOz(weightOz)
            .lengthIn(lengthIn)
            .widthIn(widthIn)
            .heightIn(heightIn)
            .shippingProfileName(shippingProfileName)
            .insuranceValueUsd(insuranceValue)
            .build();
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private String getStringOverride(Map<String, Object> overrides, String key) {
        Object val = overrides.get(key);
        return (val instanceof String s) ? s : null;
    }

    private BigDecimal getDecimalOverride(Map<String, Object> overrides, String key) {
        Object val = overrides.get(key);
        if (val == null) return null;
        try {
            return new BigDecimal(val.toString());
        } catch (NumberFormatException e) {
            log.warn("Invalid decimal override for key '{}': {}", key, val);
            return null;
        }
    }
}
