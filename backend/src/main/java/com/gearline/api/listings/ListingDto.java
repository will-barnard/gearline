package com.gearline.api.listings;

import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.product.Product;
import com.gearline.marketplace.common.connector.MarketplaceType;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

public record ListingDto(
    UUID id,
    UUID productId,
    /** Denormalised from the Product — null only if the product has been hard-deleted. */
    String productTitle,
    String productSku,
    /** Product's current price — used as a preview before the listing is first synced. */
    BigDecimal productPrice,
    Integer productQuantity,
    UUID marketplaceAccountId,
    MarketplaceType marketplaceType,
    String externalListingId,
    ListingStatus listingStatus,
    /** Price actually sent to the marketplace on the last successful sync. */
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
    public static ListingDto from(MarketplaceListing l, Product product) {
        return new ListingDto(
            l.getId(), l.getProductId(),
            product != null ? product.getTitle() : null,
            product != null ? product.getSku() : null,
            product != null ? product.getPrice() : null,
            product != null ? product.getQuantity() : null,
            l.getMarketplaceAccountId(),
            l.getMarketplaceType(), l.getExternalListingId(), l.getListingStatus(),
            l.getSyncedPrice(), l.getSyncedQuantity(), l.getLastSyncAt(),
            l.getLastError(), l.getErrorCount(), l.getListingOverrides(),
            l.getMarketplaceMetadata(), l.getCreatedAt(), l.getUpdatedAt()
        );
    }

    /** Convenience overload — product fields will be null. */
    public static ListingDto from(MarketplaceListing l) {
        return from(l, null);
    }
}
