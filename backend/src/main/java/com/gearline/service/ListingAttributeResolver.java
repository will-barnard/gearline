package com.gearline.service;

import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.product.Product;
import com.gearline.marketplace.common.dto.PublishListingRequest;
import com.gearline.marketplace.common.dto.ShippingDetails;
import com.gearline.marketplace.common.util.ShippingCalculator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Arbitrates listing attributes from three sources, in priority order:
 *
 *   1. Per-listing overrides  — stored in {@code MarketplaceListing.listingOverrides} (highest priority)
 *   2. Canonical product data — {@code Product} fields
 *   3. Hardcoded defaults     — only used when neither source has a value
 *
 * This service is the single point that translates the free-form {@code listing_overrides}
 * JSONB map into a strongly-typed {@link PublishListingRequest} before it reaches any
 * marketplace connector. Each connector mapper then applies the marketplace-specific
 * field naming on top of this resolved structure.
 *
 * <h3>Recognised override keys</h3>
 * <pre>
 * Generic (all marketplaces):
 *   title                        — replaces product.title for this channel
 *   description                  — replaces product.description for this channel
 *   price                        — decimal string, replaces product.price for this channel
 *   category_id                  — marketplace category UUID / ID
 *   condition_mapping            — marketplace-specific condition slug override
 *   image_urls                   — JSON array of strings; replaces product.imageUrls
 *   weight_oz_override           — explicit package weight in oz (skips kg→oz conversion)
 *
 * Reverb-specific:
 *   reverb_shipping_profile_name — seller shipping profile name (e.g. "Standard Guitar")
 *   reverb_model                 — model name (Reverb has make + model separately)
 *   reverb_year                  — production year as string (e.g. "1965")
 *   reverb_finish                — finish description (e.g. "Sunburst")
 *
 * eBay-specific:
 *   ebay_fulfillment_policy_id   — eBay fulfillment policy UUID
 *   ebay_return_policy_id        — eBay return policy UUID
 *   ebay_payment_policy_id       — eBay payment policy UUID
 *   ebay_category_id             — eBay leaf category ID (numeric string)
 *   ebay_item_specifics          — JSON object of name→value pairs for eBay item specifics
 * </pre>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ListingAttributeResolver {

    // Keys that are consumed by this resolver and promoted to typed fields.
    // Any remaining keys are passed through to connectors via extraParams.
    private static final List<String> RESOLVED_KEYS = List.of(
        "title", "description", "price", "category_id", "condition_mapping", "image_urls",
        "weight_oz_override", "reverb_shipping_profile_name", "ebay_fulfillment_policy_id"
    );

    private final ShippingCalculator shippingCalculator;

    /**
     * Resolve a complete {@link PublishListingRequest} for the given product and listing.
     *
     * @param product the canonical product record
     * @param listing the marketplace listing, whose {@code listingOverrides} map may be empty
     *                but is never null (default is {@code {}})
     */
    public PublishListingRequest resolve(Product product, MarketplaceListing listing) {
        Map<String, Object> overrides = listing.getListingOverrides();
        if (overrides == null) {
            overrides = Map.of();
        }

        log.debug("Resolving listing attributes for product {} on {} (overrides={})",
            product.getSku(), listing.getMarketplaceType(), overrides.keySet());

        return PublishListingRequest.builder()
            .titleOverride(getString(overrides, "title"))
            .descriptionOverride(getString(overrides, "description"))
            .priceOverride(getDecimal(overrides, "price"))
            .quantity(product.getQuantity())
            .imageUrls(resolveImageUrls(overrides, product))
            .categoryId(getString(overrides, "category_id"))
            .conditionMapping(getString(overrides, "condition_mapping"))
            .shippingDetails(shippingCalculator.resolveShipping(product, overrides))
            .extraParams(passthrough(overrides))
            .build();
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Returns image URLs from the overrides map if present, otherwise falls back
     * to the product's image list.
     */
    @SuppressWarnings("unchecked")
    private List<String> resolveImageUrls(Map<String, Object> overrides, Product product) {
        Object urlOverride = overrides.get("image_urls");
        if (urlOverride instanceof List<?> list && !list.isEmpty()) {
            return (List<String>) list;
        }
        return product.getImageUrls() != null ? product.getImageUrls() : List.of();
    }

    /**
     * Builds the extraParams map containing all override keys that were NOT promoted
     * to typed fields. This lets connector mappers read Reverb/eBay-specific keys
     * (e.g. reverb_model, ebay_item_specifics) without this class needing to know them.
     */
    private Map<String, Object> passthrough(Map<String, Object> overrides) {
        Map<String, Object> extra = new HashMap<>(overrides);
        RESOLVED_KEYS.forEach(extra::remove);
        return extra.isEmpty() ? Map.of() : extra;
    }

    private String getString(Map<String, Object> map, String key) {
        Object val = map.get(key);
        if (val instanceof String s && !s.isBlank()) return s;
        return null;
    }

    private BigDecimal getDecimal(Map<String, Object> map, String key) {
        Object val = map.get(key);
        if (val == null) return null;
        try {
            return new BigDecimal(val.toString());
        } catch (NumberFormatException e) {
            log.warn("Invalid decimal in listing_overrides key='{}' value='{}' — ignoring", key, val);
            return null;
        }
    }
}
