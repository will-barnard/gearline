package com.gearline.api.listings;

import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.marketplace.common.connector.MarketplaceType;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

public record ListingDto(
    UUID id,
    UUID productId,
    UUID marketplaceAccountId,
    MarketplaceType marketplaceType,
    String externalListingId,
    ListingStatus listingStatus,
    BigDecimal syncedPrice,
    Integer syncedQuantity,
    Instant lastSyncAt,
    String lastError,
    Integer errorCount,
    Map<String, Object> listingOverrides,
    Map<String, Object> marketplaceMetadata,
    Instant createdAt,
    Instant updatedAt
) {
    public static ListingDto from(MarketplaceListing l) {
        return new ListingDto(
            l.getId(), l.getProductId(), l.getMarketplaceAccountId(),
            l.getMarketplaceType(), l.getExternalListingId(), l.getListingStatus(),
            l.getSyncedPrice(), l.getSyncedQuantity(), l.getLastSyncAt(),
            l.getLastError(), l.getErrorCount(), l.getListingOverrides(),
            l.getMarketplaceMetadata(), l.getCreatedAt(), l.getUpdatedAt()
        );
    }
}
