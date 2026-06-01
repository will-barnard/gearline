package com.gearline.marketplace.common.util;

import com.gearline.domain.product.Dimensions;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.marketplace.common.dto.ShippingDetails;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Unit tests for ShippingCalculator — unit conversions, insurance tier rounding,
 * and composite shipping resolution from product data + listing overrides.
 */
class ShippingCalculatorTest {

    private ShippingCalculator calc;

    @BeforeEach
    void setUp() {
        calc = new ShippingCalculator();
    }

    // ── kgToOz ─────────────────────────────────────────────────────────────────

    @Test
    void kgToOz_convertsCorrectly() {
        // 1 kg = 35.274 oz (rounded to 3dp)
        assertThat(calc.kgToOz(new BigDecimal("1"))).isEqualByComparingTo("35.274");
    }

    @Test
    void kgToOz_typicalGuitarWeight() {
        // 3.5 kg electric guitar → ~123.959 oz
        assertThat(calc.kgToOz(new BigDecimal("3.5"))).isEqualByComparingTo("123.459");
    }

    @Test
    void kgToOz_returnsNull_whenInputIsNull() {
        assertThat(calc.kgToOz(null)).isNull();
    }

    @Test
    void kgToOz_zero() {
        assertThat(calc.kgToOz(BigDecimal.ZERO)).isEqualByComparingTo("0.000");
    }

    // ── cmToIn ─────────────────────────────────────────────────────────────────

    @Test
    void cmToIn_convertsCorrectly() {
        // 100 cm = 39.370 in
        assertThat(calc.cmToIn(new BigDecimal("100"))).isEqualByComparingTo("39.370");
    }

    @Test
    void cmToIn_typicalGuitarCase() {
        // Guitar case: 120 cm → 47.244 in
        assertThat(calc.cmToIn(new BigDecimal("120"))).isEqualByComparingTo("47.244");
    }

    @Test
    void cmToIn_returnsNull_whenInputIsNull() {
        assertThat(calc.cmToIn(null)).isNull();
    }

    // ── calculateInsuranceValue ────────────────────────────────────────────────

    @Test
    void insurance_exactThousand_staysAtThatTier() {
        // $1,000 → $1,000 (no bump)
        assertThat(calc.calculateInsuranceValue(new BigDecimal("1000"))).isEqualByComparingTo("1000");
    }

    @Test
    void insurance_oneDollarOver_bumpsToNextTier() {
        // $1,001 → $2,000
        assertThat(calc.calculateInsuranceValue(new BigDecimal("1001"))).isEqualByComparingTo("2000");
    }

    @Test
    void insurance_justUnderThousand_roundsUpToFirstTier() {
        // $999 → $1,000
        assertThat(calc.calculateInsuranceValue(new BigDecimal("999"))).isEqualByComparingTo("1000");
    }

    @Test
    void insurance_midTier_roundsUp() {
        // $2,400 → $3,000
        assertThat(calc.calculateInsuranceValue(new BigDecimal("2400"))).isEqualByComparingTo("3000");
    }

    @Test
    void insurance_exactFiveThousand_staysAtFive() {
        assertThat(calc.calculateInsuranceValue(new BigDecimal("5000"))).isEqualByComparingTo("5000");
    }

    @Test
    void insurance_zero_returnsZero() {
        assertThat(calc.calculateInsuranceValue(BigDecimal.ZERO)).isEqualByComparingTo("0");
    }

    @Test
    void insurance_null_returnsZero() {
        assertThat(calc.calculateInsuranceValue(null)).isEqualByComparingTo("0");
    }

    @Test
    void insurance_negative_returnsZero() {
        assertThat(calc.calculateInsuranceValue(new BigDecimal("-100"))).isEqualByComparingTo("0");
    }

    // ── resolveShipping ────────────────────────────────────────────────────────

    @Test
    void resolveShipping_convertsKgToOz_fromProduct() {
        Product product = buildProduct("2.0", null);
        ShippingDetails result = calc.resolveShipping(product, Map.of());

        // 2.0 kg = 70.548 oz
        assertThat(result.getWeightOz()).isEqualByComparingTo("70.548");
    }

    @Test
    void resolveShipping_weightOzOverride_takesPreferenceOverProductKg() {
        Product product = buildProduct("2.0", null);
        ShippingDetails result = calc.resolveShipping(product, Map.of("weight_oz_override", "96.0"));

        assertThat(result.getWeightOz()).isEqualByComparingTo("96.0");
    }

    @Test
    void resolveShipping_convertsDimensionsFromCm() {
        Dimensions dims = Dimensions.builder()
            .lengthCm(new BigDecimal("120"))
            .widthCm(new BigDecimal("40"))
            .heightCm(new BigDecimal("20"))
            .build();
        Product product = buildProduct("2.0", dims);
        ShippingDetails result = calc.resolveShipping(product, Map.of());

        assertThat(result.getLengthIn()).isEqualByComparingTo("47.244");
        assertThat(result.getWidthIn()).isEqualByComparingTo("15.748");
        assertThat(result.getHeightIn()).isEqualByComparingTo("7.874");
    }

    @Test
    void resolveShipping_nullDimensions_leavesAllDimensionsNull() {
        Product product = buildProduct("1.5", null);
        ShippingDetails result = calc.resolveShipping(product, Map.of());

        assertThat(result.getLengthIn()).isNull();
        assertThat(result.getWidthIn()).isNull();
        assertThat(result.getHeightIn()).isNull();
    }

    @Test
    void resolveShipping_reverbShippingProfileName_populatesProfileField() {
        Product product = buildProduct(null, null);
        ShippingDetails result = calc.resolveShipping(product,
            Map.of("reverb_shipping_profile_name", "456"));

        assertThat(result.getShippingProfileName()).isEqualTo("456");
    }

    @Test
    void resolveShipping_ebayFulfillmentPolicyId_fallsBackToProfileField() {
        // eBay fulfillment policy shares the shippingProfileName slot
        Product product = buildProduct(null, null);
        ShippingDetails result = calc.resolveShipping(product,
            Map.of("ebay_fulfillment_policy_id", "ebay-policy-uuid"));

        assertThat(result.getShippingProfileName()).isEqualTo("ebay-policy-uuid");
    }

    @Test
    void resolveShipping_reverbProfileTakesPrecedence_overEbayFulfillment() {
        Product product = buildProduct(null, null);
        ShippingDetails result = calc.resolveShipping(product, Map.of(
            "reverb_shipping_profile_name", "reverb-456",
            "ebay_fulfillment_policy_id", "ebay-policy-uuid"
        ));

        assertThat(result.getShippingProfileName()).isEqualTo("reverb-456");
    }

    @Test
    void resolveShipping_insuranceValue_setFromProductPrice() {
        Product product = buildProduct("1.0", null);
        product.setPrice(new BigDecimal("2400.00"));
        ShippingDetails result = calc.resolveShipping(product, Map.of());

        assertThat(result.getInsuranceValueUsd()).isEqualByComparingTo("3000");
    }

    @Test
    void resolveShipping_invalidWeightOverride_fallsBackToProductKg() {
        Product product = buildProduct("2.0", null);
        // Malformed override should be ignored
        ShippingDetails result = calc.resolveShipping(product,
            Map.of("weight_oz_override", "not-a-number"));

        assertThat(result.getWeightOz()).isEqualByComparingTo("70.548");
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private Product buildProduct(String weightKg, Dimensions dimensions) {
        Product p = Product.builder()
            .sku("TEST-001")
            .title("Test Guitar")
            .price(new BigDecimal("800.00"))
            .quantity(1)
            .condition(ProductCondition.EXCELLENT)
            .build();
        if (weightKg != null) p.setWeightKg(new BigDecimal(weightKg));
        p.setDimensions(dimensions);
        return p;
    }
}
