package com.gearline.service;

import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.infrastructure.persistence.MarketplaceListingRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Creates NEEDS_REVIEW listing stubs for all active products on a newly connected
 * marketplace account.
 *
 * When a marketplace account is connected after products have already been imported
 * from Shopify, those products won't have listing records for the new account.
 * This service backfills them so the user can see and publish them without waiting
 * for a Shopify webhook to fire.
 *
 * Only creates stubs for ACTIVE products with quantity > 0 — same criteria the
 * ShopifyWebhookProcessor uses when it creates listings on product import.
 *
 * Runs asynchronously so the OAuth callback returns immediately.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ListingBackfillService {

    private static final int PAGE_SIZE = 100;

    private final ProductRepository productRepository;
    private final MarketplaceListingRepository listingRepository;

    /**
     * Backfills NEEDS_REVIEW listing stubs for every active product that doesn't yet
     * have a listing on {@code account}. Called after a new marketplace account is saved.
     */
    @Async
    @Transactional
    public void backfillListingsForNewAccount(MarketplaceAccount account) {
        log.info("Backfilling NEEDS_REVIEW listings for new {} account {}",
            account.getMarketplaceType(), account.getId());

        int page = 0;
        int created = 0;
        int skipped = 0;

        Page<Product> batch;
        do {
            batch = productRepository.findAvailableForListing(PageRequest.of(page++, PAGE_SIZE));
            for (Product product : batch.getContent()) {
                boolean exists = listingRepository
                    .findByProductIdAndMarketplaceAccountId(product.getId(), account.getId())
                    .isPresent();

                if (exists) {
                    skipped++;
                } else {
                    MarketplaceListing stub = MarketplaceListing.builder()
                        .productId(product.getId())
                        .marketplaceAccountId(account.getId())
                        .marketplaceType(account.getMarketplaceType())
                        .listingStatus(ListingStatus.NEEDS_REVIEW)
                        .build();
                    listingRepository.save(stub);
                    created++;
                }
            }
        } while (batch.hasNext());

        log.info("Backfill complete for {} account {} — created {} stubs, skipped {} existing",
            account.getMarketplaceType(), account.getId(), created, skipped);
    }
}
