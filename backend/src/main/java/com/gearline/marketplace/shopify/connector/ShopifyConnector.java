package com.gearline.marketplace.shopify.connector;

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
 * Shopify marketplace connector.
 *
 * Shopify is the product source-of-truth in Gearline — products flow IN via
 * webhooks, not out via this connector. Accordingly:
 *
 *   - Listing operations (publish/update/delist) are no-ops. Gearline does not
 *     create or manage Shopify listings; the merchant does that in Shopify directly.
 *
 *   - Inventory sync is a no-op. Shopify inventory is updated via the
 *     Shopify Admin API by ShopifyOrderPushService when an order is imported
 *     from Reverb or eBay — not through this connector interface.
 *
 *   - Order import is a no-op. Shopify orders arrive via the orders/create
 *     webhook and are processed by ShopifyWebhookProcessor synchronously.
 *     The OrderPollingScheduler intentionally excludes Shopify from polling.
 *
 * This connector exists solely so that:
 *   1. The MarketplaceConnectorRegistry never throws for a Shopify account.
 *   2. InventoryConsistencyService can safely dispatch sync jobs to Shopify
 *      listings without a runtime crash.
 *   3. checkHealth() can verify that the stored Shopify token is still valid.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ShopifyConnector implements MarketplaceConnector {

    private final ShopifyAuthProvider authProvider;

    // ── MarketplaceConnector ───────────────────────────────────────────────────

    @Override
    public MarketplaceType getMarketplaceType() {
        return MarketplaceType.SHOPIFY;
    }

    @Override
    public ConnectorHealthResult checkHealth(MarketplaceAccount account) {
        try {
            boolean valid = authProvider.areCredentialsValid(account);
            return valid
                ? ConnectorHealthResult.healthy(MarketplaceType.SHOPIFY)
                : ConnectorHealthResult.unhealthy(MarketplaceType.SHOPIFY, "Access token invalid or expired");
        } catch (Exception e) {
            return ConnectorHealthResult.unhealthy(MarketplaceType.SHOPIFY, e.getMessage());
        }
    }

    @Override
    public MarketplaceAuthProvider getAuthProvider() {
        return authProvider;
    }

    // ── ListingPublisher — no-ops ──────────────────────────────────────────────

    /**
     * Shopify listings are managed in Shopify, not by Gearline.
     * Returns a no-op success so the calling sync job completes cleanly.
     */
    @Override
    public PublishListingResult publishListing(
        MarketplaceAccount account, Product product, PublishListingRequest request
    ) {
        log.debug("ShopifyConnector.publishListing called for SKU {} — no-op (Shopify is source-of-truth)",
            product.getSku());
        return PublishListingResult.success(null, product.getPrice(), product.getQuantity(), null);
    }

    @Override
    public PublishListingResult updateListing(
        MarketplaceAccount account, Product product,
        MarketplaceListing existingListing, PublishListingRequest request
    ) {
        log.debug("ShopifyConnector.updateListing called for SKU {} — no-op", product.getSku());
        return PublishListingResult.success(
            existingListing.getExternalListingId(), product.getPrice(), product.getQuantity(), null);
    }

    @Override
    public void delistListing(MarketplaceAccount account, MarketplaceListing listing) {
        log.debug("ShopifyConnector.delistListing called for listing {} — no-op", listing.getId());
    }

    // ── InventorySynchronizer — no-op ─────────────────────────────────────────

    /**
     * Shopify inventory is updated by ShopifyOrderPushService via the Admin API
     * when marketplace orders are imported. Cross-channel inventory sync to
     * Shopify is handled there, not here.
     */
    @Override
    public InventorySyncResult syncInventory(
        MarketplaceAccount account, MarketplaceListing listing, int newQuantity
    ) {
        log.debug("ShopifyConnector.syncInventory called for listing {} qty={} — no-op",
            listing.getId(), newQuantity);
        return InventorySyncResult.success(newQuantity);
    }

    // ── OrderImporter — no-op ─────────────────────────────────────────────────

    /**
     * Shopify orders are received via webhook (orders/create) and processed
     * synchronously by ShopifyWebhookProcessor. Polling is not used.
     */
    @Override
    public List<ImportedOrder> importOrders(MarketplaceAccount account, Instant since) {
        log.debug("ShopifyConnector.importOrders called — no-op (orders arrive via webhook)");
        return List.of();
    }

    @Override
    public ImportedOrder importOrder(MarketplaceAccount account, String externalOrderId) {
        log.debug("ShopifyConnector.importOrder called for {} — no-op", externalOrderId);
        return null;
    }
}
