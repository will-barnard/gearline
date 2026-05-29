package com.gearline.marketplace.common.connector;

import com.gearline.domain.marketplace.MarketplaceAccount;

/**
 * Root interface for all marketplace connector implementations.
 * Each marketplace (Reverb, eBay, Shopify) implements this interface
 * and composes the feature-specific interfaces below.
 *
 * Usage: resolved at runtime via MarketplaceConnectorRegistry.
 */
public interface MarketplaceConnector extends ListingPublisher, InventorySynchronizer, OrderImporter {

    /**
     * The type of marketplace this connector handles.
     */
    MarketplaceType getMarketplaceType();

    /**
     * Verifies connectivity and token validity for the given account.
     * Returns a health result — does NOT throw on connectivity failure.
     */
    ConnectorHealthResult checkHealth(MarketplaceAccount account);

    /**
     * Provides auth operations for this marketplace.
     */
    MarketplaceAuthProvider getAuthProvider();
}
