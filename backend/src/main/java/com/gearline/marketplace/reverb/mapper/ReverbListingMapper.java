package com.gearline.marketplace.reverb.mapper;

import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.marketplace.common.dto.PublishListingRequest;
import com.gearline.marketplace.common.dto.ShippingDetails;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.*;

/**
 * Maps internal domain objects to Reverb API request bodies.
 * Keeps all Reverb-specific field mapping in one place.
 *
 * Field reference: https://reverb.com/api#listings
 *
 * Shipping resolution order:
 *   1. If {@code reverb_shipping_profile_name} is set in listing_overrides →
 *      send {@code shipping_profile_name} and omit the explicit shipping block.
 *   2. If weight/dimensions are present → send weight in oz and, if all three
 *      dimensions are present, a packed dimensions block.
 *   3. If neither → listing is created without shipping data (Reverb will flag it).
 *
 * Insurance value:
 *   Reverb does not have a direct declared-value field on listings; the value is
 *   used for the seller's own insurance records and is echoed into marketplace_metadata
 *   via the PublishListingResult so it can be displayed and audited in the Gearline UI.
 */
@Component
@Slf4j
public class ReverbListingMapper {

    /**
     * Builds a Reverb listing create/update request body from an internal product.
     * All attribute resolution (overrides, shipping, insurance) is handled upstream
     * by {@link com.gearline.service.ListingAttributeResolver} before this is called.
     */
    public Map<String, Object> toReverbRequest(Product product, PublishListingRequest request) {
        Map<String, Object> listing = new LinkedHashMap<>();

        // ── Core fields ───────────────────────────────────────────────────────

        listing.put("title", request.getTitleOverride() != null
            ? request.getTitleOverride()
            : product.getTitle());

        listing.put("description", request.getDescriptionOverride() != null
            ? request.getDescriptionOverride()
            : (product.getDescription() != null ? product.getDescription() : product.getTitle()));

        BigDecimal price = request.getPriceOverride() != null ? request.getPriceOverride() : product.getPrice();
        listing.put("price", Map.of("amount", price.toPlainString(), "currency", "USD"));

        // Reverb requires two fields for inventory:
        //   has_inventory: true  — tells Reverb to track stock
        //   inventory: <n>       — flat integer (NOT a nested object)
        // Setting inventory=0 will end the listing, so callers should not pass 0 unless intentional.
        listing.put("has_inventory", true);
        listing.put("inventory", request.getQuantity());

        listing.put("condition", Map.of("slug", mapCondition(product.getCondition())));

        // make — Reverb REQUIRES both make and model to publish.
        // Fall back to "Unknown" rather than omitting, which would also result in "Unknown".
        listing.put("make", product.getBrand() != null ? product.getBrand() : "Unknown");

        listing.put("sku", product.getSku());

        // ── Reverb-specific instrument attributes (from extraParams passthrough) ──

        Map<String, Object> extra = request.getExtraParams() != null
            ? request.getExtraParams() : Map.of();

        // condition_description — optional free-text notes about the item's specific state.
        // Resolution order: listing override (reverb_condition_notes) → product.conditionNotes
        String conditionNotes = getString(extra, "reverb_condition_notes");
        if (conditionNotes == null) conditionNotes = product.getConditionNotes();
        if (conditionNotes != null && !conditionNotes.isBlank()) {
            listing.put("condition_description", conditionNotes);
        }

        // model — Reverb REQUIRES both make and model to publish.
        // Resolution order: listing override → product.model (from Shopify metafield) → product.category → product.title
        String model = getString(extra, "reverb_model");
        if (model == null) model = product.getModel();
        if (model == null) model = product.getCategory();
        if (model == null) model = product.getTitle();
        listing.put("model", model);

        // Year — production year for vintage gear.
        // Resolution order: listing override → product.yearMade (from Shopify metafield)
        String year = getString(extra, "reverb_year");
        if (year == null) year = product.getYearMade();
        if (year != null) {
            listing.put("year", year);
        }

        // Finish — colour/finish description.
        // Resolution order: listing override → product.finish (from Shopify metafield)
        String finish = getString(extra, "reverb_finish");
        if (finish == null) finish = product.getFinish();
        if (finish != null) {
            listing.put("finish", finish);
        }

        // ── Video ─────────────────────────────────────────────────────────────

        // Reverb accepts a video_link field with a full YouTube URL.
        // Check listing override first (reverb_video_url), then fall back to the product's synced videoUrl.
        String videoUrl = getString(extra, "reverb_video_url");
        if (videoUrl == null) videoUrl = product.getVideoUrl();
        if (videoUrl != null && !videoUrl.isBlank()) {
            listing.put("video_link", videoUrl);
        }

        // ── Photos ────────────────────────────────────────────────────────────

        // Reverb expects photos as a plain array of URL strings: ["url1", "url2"]
        // NOT as an array of objects like [{"source": "url"}].
        if (request.getImageUrls() != null && !request.getImageUrls().isEmpty()) {
            listing.put("photos", new ArrayList<>(request.getImageUrls()));
        }

        // ── Category ──────────────────────────────────────────────────────────

        if (request.getCategoryId() != null) {
            listing.put("categories", List.of(Map.of("uuid", request.getCategoryId())));
        }

        // ── Shipping ──────────────────────────────────────────────────────────

        ShippingDetails shipping = request.getShippingDetails();
        if (shipping != null) {
            if (shipping.getShippingProfileName() != null) {
                // Seller has a Reverb shipping profile configured.
                // The value stored in ShippingDetails.shippingProfileName for Reverb
                // is the numeric profile ID (e.g. "456") from GET /api/shop.
                // The API field is shipping_profile_id, not shipping_profile_name.
                listing.put("shipping_profile_id", shipping.getShippingProfileName());
            } else {
                // Build an explicit shipping block from physical data.
                buildShippingBlock(listing, shipping);
            }
        } else {
            log.warn("Product {} has no shipping data — Reverb listing may be incomplete", product.getSku());
        }

        // ── Any remaining extra params not handled above ──────────────────────

        extra.forEach((k, v) -> {
            // Skip the Reverb-specific keys already consumed above; pass everything else
            if (!k.startsWith("reverb_") && !k.startsWith("ebay_") && !listing.containsKey(k)) {
                listing.put(k, v);
            }
        });

        return Map.of("listing", listing);
    }

    // ── Shipping block builder ─────────────────────────────────────────────────

    /**
     * Emits a Reverb {@code weight} block and, when all three dimensions are present,
     * a {@code dimensions} block.
     *
     * Reverb weight format:
     * <pre>
     * "weight": { "value": "16.000", "unit": "oz" }
     * </pre>
     *
     * Reverb dimensions format (undocumented but accepted by the API):
     * <pre>
     * "dimensions": { "length": "24.000", "width": "12.000", "height": "8.000", "unit": "in" }
     * </pre>
     */
    private void buildShippingBlock(Map<String, Object> listing, ShippingDetails shipping) {
        if (shipping.getWeightOz() != null) {
            listing.put("weight", Map.of(
                "value", shipping.getWeightOz().toPlainString(),
                "unit", "oz"
            ));
        }

        BigDecimal l = shipping.getLengthIn();
        BigDecimal w = shipping.getWidthIn();
        BigDecimal h = shipping.getHeightIn();
        if (l != null && w != null && h != null) {
            listing.put("dimensions", Map.of(
                "length", l.toPlainString(),
                "width",  w.toPlainString(),
                "height", h.toPlainString(),
                "unit",   "in"
            ));
        }
    }

    // ── Condition mapping ──────────────────────────────────────────────────────

    /**
     * Maps internal ProductCondition to Reverb condition slugs.
     * https://reverb.com/api#listing-conditions
     */
    public String mapCondition(ProductCondition condition) {
        if (condition == null) return "used";
        return switch (condition) {
            case NEW      -> "brand-new";
            case MINT     -> "mint";
            case EXCELLENT-> "excellent";
            case VERY_GOOD-> "very-good";
            case GOOD     -> "good";
            case FAIR     -> "fair";
            case POOR     -> "poor";
            case OPEN_BOX -> "b-stock";
            case USED     -> "used";
            case FOR_PARTS-> "non-functioning";
        };
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private String getString(Map<String, Object> map, String key) {
        Object val = map.get(key);
        return (val instanceof String s && !s.isBlank()) ? s : null;
    }
}
