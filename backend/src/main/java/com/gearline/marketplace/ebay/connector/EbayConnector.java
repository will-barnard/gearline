package com.gearline.marketplace.ebay.connector;

import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Product;
import com.gearline.marketplace.common.connector.*;
import com.gearline.marketplace.common.dto.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/**
 * eBay marketplace connector.
 *
 * Implementation status: Interface stubs with full field-mapping documentation.
 *
 * eBay uses a three-step Inventory API flow (preferred over the legacy Trading API):
 *   - Inventory API:    https://developer.ebay.com/api-docs/sell/inventory/overview.html
 *   - Fulfillment API:  https://developer.ebay.com/api-docs/sell/fulfillment/overview.html
 *   - Account API:      https://developer.ebay.com/api-docs/sell/account/overview.html
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * ATTRIBUTE RESOLUTION — how PublishListingRequest fields map to eBay API fields
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * publishListing() step 1 — PUT /sell/inventory/v1/inventory_item/{sku}
 *
 *   product.title / request.titleOverride
 *       → product.title
 *
 *   product.description / request.descriptionOverride
 *       → product.description
 *
 *   product.condition (mapped via mapEbayCondition())
 *       → condition (e.g. "NEW", "LIKE_NEW", "GOOD")
 *
 *   product.imageUrls / request.imageUrls
 *       → product.imageAspects[].imageUrls[]
 *
 *   request.shippingDetails.weightOz
 *       → packageWeightAndSize.weight.value (unit = "OUNCE")
 *
 *   request.shippingDetails.lengthIn / widthIn / heightIn
 *       → packageWeightAndSize.dimensions.length/width/height (unit = "INCH")
 *         packageType = "MAILING_BOX" when all three dimensions are present
 *
 * publishListing() step 2 — POST /sell/inventory/v1/offer
 *
 *   product.price / request.priceOverride
 *       → pricingSummary.price.value (currency = "USD")
 *
 *   request.quantity
 *       → availableQuantity
 *
 *   request.categoryId (from listing_overrides: "category_id")
 *       → categoryId  (eBay leaf numeric category ID — required)
 *
 *   request.extraParams "ebay_fulfillment_policy_id"
 *       → listingPolicies.fulfillmentPolicyId  (from Account API)
 *         Use /sell/account/v1/fulfillment_policy to look up policy IDs.
 *
 *   request.extraParams "ebay_return_policy_id"
 *       → listingPolicies.returnPolicyId
 *
 *   request.extraParams "ebay_payment_policy_id"
 *       → listingPolicies.paymentPolicyId
 *
 *   request.extraParams "ebay_item_specifics" (Map<String,String>)
 *       → itemSpecifics name/value pairs  (required for many categories)
 *
 * Insurance / declared value:
 *   request.shippingDetails.insuranceValueUsd  ($1,000-tier rounded up from price)
 *       → eBay does not accept a separate declared value on the offer itself.
 *         Pass it to your shipping carrier (EasyPost, EasyShip, etc.) when
 *         purchasing labels. Store it in marketplace_metadata["insurance_value_usd"]
 *         (SyncDispatcherService already does this).
 *
 * publishListing() step 3 — POST /sell/inventory/v1/offer/{offerId}/publish
 *   No Gearline fields needed; returns listingId which becomes externalListingId.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * All logic belongs under marketplace/ebay/. Do not reference eBay types from core domain.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class EbayConnector implements MarketplaceConnector {

    private final EbayAuthProvider authProvider;

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

    @Override
    public PublishListingResult publishListing(
        MarketplaceAccount account,
        Product product,
        PublishListingRequest request
    ) {
        // TODO: Step 1 — PUT /sell/inventory/v1/inventory_item/{sku}
        //   Body includes: product (title, desc, condition, images),
        //   packageWeightAndSize from request.shippingDetails (OUNCE / INCH),
        //   availability.shipToLocationAvailability.quantity = request.quantity
        //
        // TODO: Step 2 — POST /sell/inventory/v1/offer
        //   Body includes: sku, marketplaceId = "EBAY_US",
        //   pricingSummary.price from request.priceOverride ?? product.price,
        //   categoryId from request.categoryId,
        //   listingPolicies.fulfillmentPolicyId from request.extraParams["ebay_fulfillment_policy_id"],
        //   listingPolicies.returnPolicyId from request.extraParams["ebay_return_policy_id"],
        //   listingPolicies.paymentPolicyId from request.extraParams["ebay_payment_policy_id"],
        //   itemSpecifics from request.extraParams["ebay_item_specifics"]
        //
        // TODO: Step 3 — POST /sell/inventory/v1/offer/{offerId}/publish
        //   Returns { listingId: "..." } — store as externalListingId
        log.warn("eBay publishListing not yet implemented for product {}", product.getSku());
        return PublishListingResult.failure("eBay listing publishing not yet implemented");
    }

    @Override
    public PublishListingResult updateListing(
        MarketplaceAccount account,
        Product product,
        MarketplaceListing existingListing,
        PublishListingRequest request
    ) {
        // TODO: PUT /sell/inventory/v1/inventory_item/{sku} (full replace)
        // Then PATCH /sell/inventory/v1/offer/{offerId} for price/policy changes
        // Then POST /sell/inventory/v1/offer/{offerId}/publish to push live
        log.warn("eBay updateListing not yet implemented for listing {}", existingListing.getExternalListingId());
        return PublishListingResult.failure("eBay listing updates not yet implemented");
    }

    @Override
    public void delistListing(MarketplaceAccount account, MarketplaceListing listing) {
        // TODO: POST /sell/inventory/v1/offer/{offerId}/withdraw
        // offerId is stored in listing.marketplaceMetadata["ebay_offer_id"]
        log.warn("eBay delistListing not yet implemented for listing {}", listing.getExternalListingId());
    }

    @Override
    public InventorySyncResult syncInventory(
        MarketplaceAccount account,
        MarketplaceListing listing,
        int newQuantity
    ) {
        // TODO: PUT /sell/inventory/v1/inventory_item/{sku}
        // Update only: availability.shipToLocationAvailability.quantity = newQuantity
        // The rest of the inventory item body must be preserved (fetch-then-patch pattern)
        log.warn("eBay syncInventory not yet implemented for listing {}", listing.getExternalListingId());
        return InventorySyncResult.failure("eBay inventory sync not yet implemented");
    }

    @Override
    public List<ImportedOrder> importOrders(MarketplaceAccount account, Instant since) {
        // TODO: GET /sell/fulfillment/v1/order
        // filter: filter=creationdate:[{since}..], limit=50, offset pagination
        // Map OrderDto.lineItems[].sku to product via productRepository.findBySku()
        log.warn("eBay importOrders not yet implemented for account {}", account.getId());
        return List.of();
    }

    @Override
    public ImportedOrder importOrder(MarketplaceAccount account, String externalOrderId) {
        // TODO: GET /sell/fulfillment/v1/order/{orderId}
        log.warn("eBay importOrder not yet implemented for order {}", externalOrderId);
        throw new UnsupportedOperationException("eBay order import not yet implemented");
    }
}
