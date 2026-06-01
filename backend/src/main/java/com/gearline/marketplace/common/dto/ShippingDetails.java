package com.gearline.marketplace.common.dto;

import lombok.Builder;
import lombok.Value;

import java.math.BigDecimal;

/**
 * Normalized shipping parameters for a marketplace listing.
 *
 * All physical measurements are stored in imperial units because both Reverb and eBay
 * expect imperial. The ShippingCalculator converts from the product's metric storage
 * (kg / cm) at resolve time.
 *
 * Insurance value is the declared shipment value used to calculate insurance tiers,
 * rounded up to the nearest $1,000 increment per industry convention.
 */
@Value
@Builder
public class ShippingDetails {

    /**
     * Package weight in ounces.
     * Reverb: listing.weight.value (unit = "oz")
     * eBay:   packageWeightAndSize.weight.value (unit = OUNCE)
     */
    BigDecimal weightOz;

    /**
     * Package dimensions in inches.
     * Reverb: listing.weight.dimensions (inches)
     * eBay:   packageWeightAndSize.dimensions (unit = INCH)
     */
    BigDecimal lengthIn;
    BigDecimal widthIn;
    BigDecimal heightIn;

    /**
     * Seller-configured shipping profile identifier on the target marketplace.
     *
     * Reverb: the numeric profile ID from GET /api/shop → shipping_profiles[].id
     *         (e.g. "456"). Sent as shipping_profile_id on the create/update request.
     *         Store in listing_overrides as "reverb_shipping_profile_id".
     *
     * eBay:   the UUID fulfillment policy ID from the eBay Account API.
     *         Sent as listingPolicies.fulfillmentPolicyId on the offer.
     *         Store in listing_overrides as "ebay_fulfillment_policy_id".
     *
     * When set, this takes precedence over weight/dimension-based shipping data.
     */
    String shippingProfileName;

    /**
     * Declared value for package insurance, rounded up to the nearest $1,000.
     *
     * Example: product price $2,400 → insuranceValueUsd = $3,000
     *
     * Both Reverb and eBay factor this into their optional insurance add-ons.
     * Pass-through only — the marketplaces compute the actual insurance premium.
     */
    BigDecimal insuranceValueUsd;
}
