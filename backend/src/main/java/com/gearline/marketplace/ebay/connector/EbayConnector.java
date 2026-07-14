package com.gearline.marketplace.ebay.connector;

import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.marketplace.common.connector.*;
import com.gearline.marketplace.common.dto.*;
import com.gearline.marketplace.ebay.client.EbayApiClient;
import com.gearline.marketplace.ebay.client.EbayApiException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;

/**
 * eBay marketplace connector — full implementation.
 *
 * Listing sync uses the eBay Inventory API v1 three-step flow:
 *   1. PUT  /sell/inventory/v1/inventory_item/{sku}    — create/replace inventory item
 *   2. POST /sell/inventory/v1/offer                   — create offer (returns offerId)
 *      OR
 *      PUT  /sell/inventory/v1/offer/{offerId}         — update existing offer
 *   3. POST /sell/inventory/v1/offer/{offerId}/publish — publish (returns listingId)
 *
 * The offerId is persisted in {@code listing.marketplaceMetadata["ebay_offer_id"]}
 * and is required for update and delist operations.
 *
 * Order polling uses the eBay Fulfillment API v1:
 *   GET /sell/fulfillment/v1/order?filter=creationdate:[{since}..] (paginated, limit=50)
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class EbayConnector implements MarketplaceConnector {

    private final EbayAuthProvider authProvider;
    private final EbayApiClient ebayApiClient;
    private final EbayOrderMapper orderMapper;

    @Override
    public MarketplaceType getMarketplaceType() {
        return MarketplaceType.EBAY;
    }

    @Override
    public MarketplaceAuthProvider getAuthProvider() {
        return authProvider;
    }

    @Override
    public ConnectorHealthResult checkHealth(MarketplaceAccount account) {
        log.info("eBay health check for account {}", account.getId());
        return authProvider.areCredentialsValid(account)
            ? ConnectorHealthResult.healthy(MarketplaceType.EBAY)
            : ConnectorHealthResult.unhealthy(MarketplaceType.EBAY, "Token invalid or expired");
    }

    // ── Listing sync ───────────────────────────────────────────────────────────

    @Override
    public PublishListingResult publishListing(
        MarketplaceAccount account,
        Product product,
        PublishListingRequest request
    ) {
        ensureValidToken(account);
        try {
            String sku = product.getSku();

            // Step 1 — PUT inventory item
            Map<String, Object> inventoryBody = buildInventoryItemBody(product, request);
            ebayApiClient.createOrUpdateInventoryItem(account, sku, inventoryBody);
            log.info("eBay: inventory item created/updated for SKU {}", sku);

            // Step 2 — POST offer
            // Finding #7: null-guard createOffer response — null means eBay returned an empty body
            Map<String, Object> offerBody = buildOfferBody(sku, product, request);
            Map<String, Object> offerResponse = ebayApiClient.createOffer(account, offerBody);
            if (offerResponse == null) {
                throw new EbayApiException("createOffer returned null response for SKU " + sku, null);
            }
            String offerId = (String) offerResponse.get("offerId");
            if (offerId == null || offerId.isBlank()) {
                throw new EbayApiException("createOffer returned no offerId for SKU " + sku
                    + " — response: " + offerResponse, null);
            }
            log.info("eBay: offer created {} for SKU {}", offerId, sku);

            // Step 3 — POST publish
            Map<String, Object> publishResponse = ebayApiClient.publishOffer(account, offerId);
            String listingId = (String) publishResponse.get("listingId");
            log.info("eBay: offer {} published — listingId {}", offerId, listingId);

            BigDecimal price = request.getPriceOverride() != null
                ? request.getPriceOverride()
                : product.getPrice();

            Map<String, Object> metadata = new HashMap<>();
            metadata.put("ebay_offer_id", offerId);
            metadata.put("sku", sku);

            return PublishListingResult.success(listingId, price, request.getQuantity(), metadata);

        } catch (EbayApiException e) {
            log.error("eBay publishListing failed for SKU {}: {}", product.getSku(), e.getMessage());
            return PublishListingResult.failure(e.getMessage());
        }
    }

    @Override
    public PublishListingResult updateListing(
        MarketplaceAccount account,
        Product product,
        MarketplaceListing existingListing,
        PublishListingRequest request
    ) {
        ensureValidToken(account);
        try {
            String sku = product.getSku();
            String offerId = getOfferId(existingListing);

            // Step 1 — replace inventory item (full replace is idempotent)
            Map<String, Object> inventoryBody = buildInventoryItemBody(product, request);
            ebayApiClient.createOrUpdateInventoryItem(account, sku, inventoryBody);
            log.info("eBay: inventory item updated for SKU {}", sku);

            // Step 2 — update or create offer
            Map<String, Object> offerBody = buildOfferBody(sku, product, request);
            if (offerId != null) {
                ebayApiClient.updateOffer(account, offerId, offerBody);
                log.info("eBay: offer {} updated for SKU {}", offerId, sku);
            } else {
                // Finding #7: null-guard createOffer response
                Map<String, Object> offerResponse = ebayApiClient.createOffer(account, offerBody);
                if (offerResponse == null) {
                    throw new EbayApiException("createOffer returned null response for SKU " + sku, null);
                }
                offerId = (String) offerResponse.get("offerId");
                if (offerId == null || offerId.isBlank()) {
                    throw new EbayApiException("createOffer returned no offerId for SKU " + sku, null);
                }
                log.info("eBay: offer {} created (was missing) for SKU {}", offerId, sku);
            }

            // Step 3 — re-publish
            Map<String, Object> publishResponse = ebayApiClient.publishOffer(account, offerId);
            String listingId = (String) publishResponse.get("listingId");
            log.info("eBay: offer {} re-published — listingId {}", offerId, listingId);

            BigDecimal price = request.getPriceOverride() != null
                ? request.getPriceOverride()
                : product.getPrice();

            Map<String, Object> metadata = new HashMap<>();
            metadata.put("ebay_offer_id", offerId);
            metadata.put("sku", sku);

            return PublishListingResult.success(listingId, price, request.getQuantity(), metadata);

        } catch (EbayApiException e) {
            log.error("eBay updateListing failed for listing {}: {}",
                existingListing.getExternalListingId(), e.getMessage());
            return PublishListingResult.failure(e.getMessage());
        }
    }

    @Override
    public void delistListing(MarketplaceAccount account, MarketplaceListing listing) {
        ensureValidToken(account);
        String offerId = getOfferId(listing);
        if (offerId == null) {
            log.warn("eBay delistListing: no ebay_offer_id in metadata for listing {} — skipping withdraw",
                listing.getExternalListingId());
            return;
        }
        try {
            ebayApiClient.withdrawOffer(account, offerId);
            log.info("eBay: offer {} withdrawn for listing {}", offerId, listing.getExternalListingId());
        } catch (EbayApiException e) {
            log.error("eBay delistListing failed for offer {}: {}", offerId, e.getMessage());
            throw e;
        }
    }

    /**
     * Syncs the quantity for an existing eBay inventory item.
     *
     * Finding #4 fix: the eBay Inventory API PUT is a full replace, not a PATCH.
     * Sending only an availability block would wipe the listing's product title,
     * description, images, and condition. We now GET the current inventory item
     * first, update only the availability block, and PUT the full merged body back.
     */
    @Override
    @SuppressWarnings("unchecked")
    public InventorySyncResult syncInventory(
        MarketplaceAccount account,
        MarketplaceListing listing,
        int newQuantity
    ) {
        ensureValidToken(account);
        try {
            String sku = getSkuFromListing(listing);
            if (sku == null) {
                return InventorySyncResult.failure(
                    "Cannot sync eBay inventory: no SKU available for listing " + listing.getId());
            }

            // GET the current inventory item so we can preserve all existing fields.
            Map<String, Object> existing = ebayApiClient.getInventoryItem(account, sku);
            if (existing == null) {
                // Item doesn't exist yet — eBay may have removed it; log and return failure.
                log.warn("eBay inventory item for SKU {} not found — cannot sync quantity", sku);
                return InventorySyncResult.failure(
                    "eBay inventory item for SKU " + sku + " not found; please re-publish the listing");
            }

            // Merge the new quantity into the existing body (full replace preserves all other fields)
            Map<String, Object> availability = new LinkedHashMap<>();
            availability.put("shipToLocationAvailability", Map.of("quantity", newQuantity));
            existing.put("availability", availability);

            ebayApiClient.createOrUpdateInventoryItem(account, sku, existing);
            log.info("eBay: inventory synced for SKU {} → quantity {}", sku, newQuantity);
            return InventorySyncResult.success(newQuantity);

        } catch (EbayApiException e) {
            log.error("eBay syncInventory failed for listing {}: {}",
                listing.getExternalListingId(), e.getMessage());
            return InventorySyncResult.failure(e.getMessage());
        }
    }

    // ── Order polling ──────────────────────────────────────────────────────────

    @Override
    @SuppressWarnings("unchecked")
    public List<ImportedOrder> importOrders(MarketplaceAccount account, Instant since) {
        ensureValidToken(account);
        List<ImportedOrder> results = new ArrayList<>();
        String sinceStr = since.toString(); // ISO-8601

        int offset = 0;
        boolean hasMore = true;

        while (hasMore) {
            try {
                // Finding #14: getOrders() can return null (empty body from eBay); guard it.
                Map<String, Object> page = ebayApiClient.getOrders(account, sinceStr, offset);
                if (page == null) break;
                List<Map<String, Object>> orders = (List<Map<String, Object>>) page.get("orders");

                if (orders == null || orders.isEmpty()) break;

                for (Map<String, Object> raw : orders) {
                    ImportedOrder order = orderMapper.map(raw);
                    if (order != null) {
                        results.add(order);
                    }
                }

                // eBay returns "next" cursor when more pages exist
                hasMore = page.containsKey("next");
                offset += orders.size();

            } catch (EbayApiException e) {
                log.error("eBay importOrders failed at offset {}: {}", offset, e.getMessage());
                break;
            }
        }

        log.info("eBay: imported {} orders for account {} since {}", results.size(), account.getId(), sinceStr);
        return results;
    }

    @Override
    public ImportedOrder importOrder(MarketplaceAccount account, String externalOrderId) {
        ensureValidToken(account);
        try {
            Map<String, Object> raw = ebayApiClient.getOrder(account, externalOrderId);
            ImportedOrder order = orderMapper.map(raw);
            if (order == null) {
                throw new EbayApiException("Failed to map eBay order " + externalOrderId, null);
            }
            return order;
        } catch (EbayApiException e) {
            log.error("eBay importOrder failed for order {}: {}", externalOrderId, e.getMessage());
            throw e;
        }
    }

    // ── Request builders ───────────────────────────────────────────────────────

    /**
     * Builds the body for PUT /sell/inventory/v1/inventory_item/{sku}.
     */
    private Map<String, Object> buildInventoryItemBody(Product product, PublishListingRequest request) {
        Map<String, Object> body = new LinkedHashMap<>();

        // product block
        Map<String, Object> productBlock = new LinkedHashMap<>();
        String title = request.getTitleOverride() != null ? request.getTitleOverride() : product.getTitle();
        String description = request.getDescriptionOverride() != null
            ? request.getDescriptionOverride()
            : product.getDescription();
        productBlock.put("title", title);
        if (description != null) productBlock.put("description", description);

        // images — eBay allows up to 12 image URLs on the product block
        List<String> imageUrls = request.getImageUrls() != null && !request.getImageUrls().isEmpty()
            ? request.getImageUrls()
            : product.getImageUrls();
        if (imageUrls != null && !imageUrls.isEmpty()) {
            List<String> urlList = new ArrayList<>(imageUrls);
            if (urlList.size() > 12) urlList = urlList.subList(0, 12);
            productBlock.put("imageUrls", urlList);
        }

        // aspects (item specifics) — eBay expects Map<String, List<String>> at product.aspects.
        // Auto-populate from product fields first, then merge any caller-supplied overrides
        // from extraParams["ebay_item_specifics"] (caller values win on conflict).
        // Note: aspects belong on the inventory item PUT, NOT on the offer body.
        @SuppressWarnings("unchecked")
        Map<String, Object> extraParams = request.getExtraParams() != null ? request.getExtraParams() : Map.of();

        Map<String, List<String>> aspects = new LinkedHashMap<>();
        if (product.getBrand() != null && !product.getBrand().isBlank()) {
            aspects.put("Brand", List.of(product.getBrand()));
        }
        if (product.getModel() != null && !product.getModel().isBlank()) {
            aspects.put("Model", List.of(product.getModel()));
        }
        if (product.getYearMade() != null && !product.getYearMade().isBlank()) {
            aspects.put("Year Manufactured", List.of(product.getYearMade()));
        }
        if (product.getFinish() != null && !product.getFinish().isBlank()) {
            aspects.put("Color", List.of(product.getFinish()));
        }
        // Caller-provided specifics override auto-populated values
        Object specificsRaw = extraParams.get("ebay_item_specifics");
        if (specificsRaw instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, String> specifics = (Map<String, String>) specificsRaw;
            specifics.forEach((k, v) -> aspects.put(k, List.of(v)));
        }
        if (!aspects.isEmpty()) {
            productBlock.put("aspects", aspects);
        }

        body.put("product", productBlock);

        // condition
        body.put("condition", mapEbayCondition(product.getCondition()));

        // conditionDescription — free-text notes about the item's state.
        // Resolution order: extraParams override → product.conditionNotes
        String conditionDescription = null;
        Object cdOverride = extraParams.get("ebay_condition_description");
        if (cdOverride instanceof String s && !s.isBlank()) conditionDescription = s;
        if (conditionDescription == null && product.getConditionNotes() != null
                && !product.getConditionNotes().isBlank()) {
            conditionDescription = product.getConditionNotes();
        }
        if (conditionDescription != null) {
            body.put("conditionDescription", conditionDescription);
        }

        // package weight and size
        ShippingDetails shipping = request.getShippingDetails();
        if (shipping != null) {
            Map<String, Object> packageInfo = new LinkedHashMap<>();
            if (shipping.getWeightOz() != null) {
                packageInfo.put("weight", Map.of(
                    "value", shipping.getWeightOz(),
                    "unit", "OUNCE"
                ));
            }
            boolean hasDimensions = shipping.getLengthIn() != null
                && shipping.getWidthIn() != null
                && shipping.getHeightIn() != null;
            if (hasDimensions) {
                packageInfo.put("dimensions", Map.of(
                    "length", shipping.getLengthIn(),
                    "width", shipping.getWidthIn(),
                    "height", shipping.getHeightIn(),
                    "unit", "INCH"
                ));
                // Choose package type based on weight — eBay uses this for display and
                // carrier eligibility checks. VERY_LARGE_PACKAGE covers freight-sized items.
                // MAILING_BOX is only appropriate for small parcel shipments.
                BigDecimal weightOz = shipping.getWeightOz();
                String packageType = (weightOz != null && weightOz.compareTo(new BigDecimal("320")) > 0)
                    ? "VERY_LARGE_PACKAGE"  // >20 lbs — freight territory
                    : "MAILING_BOX";
                packageInfo.put("packageType", packageType);
            }
            if (!packageInfo.isEmpty()) {
                body.put("packageWeightAndSize", packageInfo);
            }
        }

        // availability
        body.put("availability", Map.of(
            "shipToLocationAvailability", Map.of(
                "quantity", request.getQuantity()
            )
        ));

        return body;
    }

    /**
     * Builds the body for POST /sell/inventory/v1/offer (create) or
     * PUT /sell/inventory/v1/offer/{offerId} (update).
     */
    private Map<String, Object> buildOfferBody(String sku, Product product, PublishListingRequest request) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sku", sku);
        body.put("marketplaceId", "EBAY_US");
        body.put("format", "FIXED_PRICE");

        // price
        BigDecimal price = request.getPriceOverride() != null ? request.getPriceOverride() : product.getPrice();
        body.put("pricingSummary", Map.of(
            "price", Map.of(
                "value", price.toPlainString(),
                "currency", "USD"
            )
        ));

        // quantity
        body.put("availableQuantity", request.getQuantity());

        // category
        if (request.getCategoryId() != null) {
            body.put("categoryId", request.getCategoryId());
        }

        // listing policies + merchant location
        Map<String, Object> extraParams = request.getExtraParams();
        if (extraParams != null) {
            Map<String, Object> policies = new LinkedHashMap<>();
            Object fulfillmentPolicy = extraParams.get("ebay_fulfillment_policy_id");
            Object returnPolicy = extraParams.get("ebay_return_policy_id");
            Object paymentPolicy = extraParams.get("ebay_payment_policy_id");
            if (fulfillmentPolicy != null) policies.put("fulfillmentPolicyId", fulfillmentPolicy.toString());
            if (returnPolicy != null)      policies.put("returnPolicyId", returnPolicy.toString());
            if (paymentPolicy != null)     policies.put("paymentPolicyId", paymentPolicy.toString());
            if (!policies.isEmpty()) body.put("listingPolicies", policies);

            // merchantLocationKey — required by eBay before an offer can be published.
            // Sellers must configure an inventory location via the Inventory Location API;
            // the key is stored in extraParams as "ebay_merchant_location_key".
            Object locationKey = extraParams.get("ebay_merchant_location_key");
            if (locationKey != null) {
                body.put("merchantLocationKey", locationKey.toString());
            }
            // Note: item specifics (ebay_item_specifics) are sent as product.aspects on the
            // inventory item PUT, not here. See buildInventoryItemBody().
        }

        return body;
    }

    // ── Condition mapping ──────────────────────────────────────────────────────

    /**
     * Maps Gearline's {@link ProductCondition} to eBay Inventory API condition enum strings.
     *
     * Valid eBay Inventory API condition values:
     *   NEW, LIKE_NEW, NEW_OTHER, NEW_WITH_DEFECTS, SELLER_REFURBISHED,
     *   USED_EXCELLENT, USED_VERY_GOOD, USED_GOOD, USED_ACCEPTABLE,
     *   FOR_PARTS_OR_NOT_WORKING
     *
     * IMPORTANT: "VERY_GOOD", "GOOD", "ACCEPTABLE" (without the "USED_" prefix) are NOT
     * valid strings and will be rejected by the eBay API with a 400 error.
     */
    private String mapEbayCondition(ProductCondition condition) {
        if (condition == null) return "USED_EXCELLENT";
        return switch (condition) {
            case NEW       -> "NEW";
            case OPEN_BOX  -> "NEW_OTHER";
            case MINT      -> "LIKE_NEW";
            case EXCELLENT -> "USED_EXCELLENT";
            case VERY_GOOD -> "USED_VERY_GOOD";
            case GOOD      -> "USED_GOOD";
            case FAIR,
                 USED      -> "USED_ACCEPTABLE";
            case POOR,
                 FOR_PARTS -> "FOR_PARTS_OR_NOT_WORKING";
        };
    }

    // ── Metadata helpers ───────────────────────────────────────────────────────

    private String getOfferId(MarketplaceListing listing) {
        Map<String, Object> meta = listing.getMarketplaceMetadata();
        if (meta == null) return null;
        Object offerId = meta.get("ebay_offer_id");
        return offerId != null ? offerId.toString() : null;
    }

    private String getSkuFromListing(MarketplaceListing listing) {
        Map<String, Object> meta = listing.getMarketplaceMetadata();
        if (meta != null) {
            Object sku = meta.get("sku");
            if (sku != null) return sku.toString();
        }
        // Fall back: externalListingId is the listingId, not the SKU.
        // Callers that need this should ensure "sku" is stored in marketplaceMetadata
        // at publish time, or pass the Product directly.
        return null;
    }

    // ── Token management ───────────────────────────────────────────────────────

    /**
     * Proactively refreshes the eBay access token if it has expired or is within
     * the 5-minute expiry buffer checked by {@link EbayAuthProvider#areCredentialsValid}.
     *
     * Called at the top of every public connector method so tokens are always
     * fresh before the first API call of a sync cycle.
     */
    private void ensureValidToken(MarketplaceAccount account) {
        if (!authProvider.areCredentialsValid(account)) {
            log.info("eBay token expired or near-expiry for account {} — refreshing", account.getId());
            authProvider.refreshAccessToken(account);
        }
    }
}
