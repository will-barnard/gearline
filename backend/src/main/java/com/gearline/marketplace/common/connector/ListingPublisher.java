package com.gearline.marketplace.common.connector;

import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Product;
import com.gearline.marketplace.common.dto.PublishListingRequest;
import com.gearline.marketplace.common.dto.PublishListingResult;

/**
 * Handles creating, updating, and removing listings on an external marketplace.
 */
public interface ListingPublisher {

    /**
     * Creates a new listing on the marketplace.
     * Returns a result containing the external listing ID on success.
     */
    PublishListingResult publishListing(
        MarketplaceAccount account,
        Product product,
        PublishListingRequest request
    );

    /**
     * Updates an existing listing on the marketplace.
     * Implementations should handle partial updates efficiently.
     */
    PublishListingResult updateListing(
        MarketplaceAccount account,
        Product product,
        MarketplaceListing existingListing,
        PublishListingRequest request
    );

    /**
     * Removes/ends a listing on the marketplace.
     * Should not throw if the listing is already gone on the external system.
     */
    void delistListing(MarketplaceAccount account, MarketplaceListing listing);
}
