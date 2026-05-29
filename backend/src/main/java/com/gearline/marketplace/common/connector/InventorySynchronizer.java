package com.gearline.marketplace.common.connector;

import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.marketplace.common.dto.InventorySyncResult;

/**
 * Handles pushing inventory quantity updates to an external marketplace.
 * Implementations must be idempotent — calling with the same quantity multiple times
 * should not produce errors or duplicate changes.
 */
public interface InventorySynchronizer {

    /**
     * Updates the available quantity for a listing on the marketplace.
     */
    InventorySyncResult syncInventory(
        MarketplaceAccount account,
        MarketplaceListing listing,
        int newQuantity
    );

    /**
     * Pushes inventory to zero (sold out) for a listing.
     * Should not delist — only update quantity.
     */
    default InventorySyncResult markSoldOut(MarketplaceAccount account, MarketplaceListing listing) {
        return syncInventory(account, listing, 0);
    }
}
