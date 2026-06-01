package com.gearline.marketplace.common.dto;

import lombok.Builder;
import lombok.Value;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

/**
 * Normalized request to publish or update a listing on any marketplace.
 *
 * Built exclusively by {@link com.gearline.service.ListingAttributeResolver}, which
 * arbitrates between canonical product fields and per-channel {@code listing_overrides}.
 * Connector mappers read from this object and translate field names to marketplace spec.
 *
 * Marketplace-specific keys that have no typed field here (e.g. reverb_model,
 * ebay_item_specifics) are passed through in {@code extraParams}.
 */
@Value
@Builder(toBuilder = true)
public class PublishListingRequest {
    /** Override title (falls back to product title if null) */
    String titleOverride;

    /** Override description (falls back to product description if null) */
    String descriptionOverride;

    /** Override price (falls back to product price if null) */
    BigDecimal priceOverride;

    /** Quantity to list */
    int quantity;

    /** Images to include (URLs); overrides from listing_overrides take precedence */
    List<String> imageUrls;

    /** Marketplace-specific category UUID or ID */
    String categoryId;

    /** Marketplace-specific condition slug override */
    String conditionMapping;

    /**
     * Resolved shipping parameters — weight (oz), dimensions (in), shipping profile,
     * and insurance value. Null only when the product has no physical data at all.
     * Each connector mapper decides which fields to send to its API.
     */
    ShippingDetails shippingDetails;

    /**
     * Pass-through map for marketplace-specific keys that have no typed field above.
     * Examples:
     *   reverb_model, reverb_year, reverb_finish
     *   ebay_return_policy_id, ebay_payment_policy_id, ebay_item_specifics
     */
    Map<String, Object> extraParams;
}
