package com.gearline.infrastructure.persistence;

import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.marketplace.common.connector.MarketplaceType;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface MarketplaceListingRepository extends JpaRepository<MarketplaceListing, UUID> {

    List<MarketplaceListing> findByProductId(UUID productId);
    List<MarketplaceListing> findByMarketplaceAccountId(UUID accountId);
    List<MarketplaceListing> findByProductIdAndListingStatus(UUID productId, ListingStatus status);

    Optional<MarketplaceListing> findByProductIdAndMarketplaceAccountId(UUID productId, UUID accountId);

    Optional<MarketplaceListing> findByMarketplaceTypeAndExternalListingId(
        MarketplaceType type, String externalListingId
    );

    Page<MarketplaceListing> findByListingStatus(ListingStatus status, Pageable pageable);

    @Query("SELECT l FROM MarketplaceListing l WHERE l.listingStatus = 'ACTIVE' AND l.productId = :productId")
    List<MarketplaceListing> findActiveListingsForProduct(@Param("productId") UUID productId);

    @Query("SELECT COUNT(l) FROM MarketplaceListing l WHERE l.listingStatus = 'ACTIVE'")
    long countActiveListings();

    @Query("SELECT COUNT(l) FROM MarketplaceListing l WHERE l.listingStatus = 'FAILED'")
    long countFailedListings();

    @Query("SELECT COUNT(l) FROM MarketplaceListing l WHERE l.listingStatus = 'NEEDS_REVIEW'")
    long countNeedsReviewListings();
}
