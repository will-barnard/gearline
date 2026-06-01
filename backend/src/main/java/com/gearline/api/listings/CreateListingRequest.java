package com.gearline.api.listings;

import jakarta.validation.constraints.NotNull;

import java.util.Map;
import java.util.UUID;

/**
 * Request body for POST /api/v1/listings.
 * Creates a new listing record in PENDING state, ready to be published.
 */
public record CreateListingRequest(
    @NotNull UUID productId,
    @NotNull UUID marketplaceAccountId,

    /**
     * Optional marketplace-specific overrides (price, title, reverb_model, etc.)
     * Merged into the listing's listingOverrides map on creation.
     */
    Map<String, Object> overrides
) {}
