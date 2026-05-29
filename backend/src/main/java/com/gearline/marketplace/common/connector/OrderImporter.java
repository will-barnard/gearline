package com.gearline.marketplace.common.connector;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.marketplace.common.dto.ImportedOrder;

import java.time.Instant;
import java.util.List;

/**
 * Handles importing orders from an external marketplace into Gearline.
 */
public interface OrderImporter {

    /**
     * Fetches orders from the marketplace that were created after the given timestamp.
     * Results should be mapped to ImportedOrder using the marketplace-specific adapter.
     */
    List<ImportedOrder> importOrders(MarketplaceAccount account, Instant since);

    /**
     * Imports a single order by its external ID.
     * Used for on-demand imports triggered by webhooks.
     */
    ImportedOrder importOrder(MarketplaceAccount account, String externalOrderId);
}
