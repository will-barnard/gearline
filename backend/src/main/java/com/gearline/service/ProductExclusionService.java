package com.gearline.service;

import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.product.Product;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.infrastructure.messaging.SyncJobProducer;
import com.gearline.infrastructure.persistence.MarketplaceListingRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * Manages the marketplace_excluded flag on products.
 *
 * When a product is excluded:
 *   1. NEEDS_REVIEW / PENDING / FAILED listing stubs are deleted outright —
 *      they've never been published so there's nothing to delist on the marketplace.
 *   2. ACTIVE listings get a LISTING_DELIST job queued so they are removed from
 *      the live marketplace, then their status is updated to DELISTED.
 *   3. The flag is set on the Product record; Shopify webhooks will never clear it.
 *
 * When a product is un-excluded the flag is cleared. The product will reappear in
 * the review queue on the next Shopify webhook or when the user manually triggers a sync.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ProductExclusionService {

    private final ProductRepository productRepository;
    private final MarketplaceListingRepository listingRepository;
    private final SyncJobProducer syncJobProducer;

    // ── Single product ─────────────────────────────────────────────────────────

    @Transactional
    public Product setExcluded(UUID productId, boolean excluded) {
        Product product = productRepository.findById(productId)
            .orElseThrow(() -> new IllegalArgumentException("Product not found: " + productId));

        if (product.isMarketplaceExcluded() == excluded) {
            return product; // no change needed
        }

        product.setMarketplaceExcluded(excluded);
        product = productRepository.save(product);

        if (excluded) {
            applyExclusionSideEffects(product.getId(), product.getSku());
        }

        log.info("Product {} ({}) marketplace_excluded set to {}", product.getSku(), productId, excluded);
        return product;
    }

    // ── Bulk ──────────────────────────────────────────────────────────────────

    @Transactional
    public int bulkSetExcluded(List<UUID> productIds, boolean excluded) {
        if (productIds == null || productIds.isEmpty()) return 0;

        int updated = productRepository.bulkSetMarketplaceExcluded(productIds, excluded);

        if (excluded) {
            for (UUID id : productIds) {
                productRepository.findById(id).ifPresent(p ->
                    applyExclusionSideEffects(p.getId(), p.getSku())
                );
            }
        }

        log.info("Bulk marketplace_excluded={} applied to {} products", excluded, updated);
        return updated;
    }

    // ── Side effects when excluding ────────────────────────────────────────────

    /**
     * Cleans up all marketplace listing state for a newly-excluded product:
     *  - Deletes stubs that have never been published (no external listing ID)
     *  - Queues LISTING_DELIST jobs for any listings that are live on a marketplace
     */
    private void applyExclusionSideEffects(UUID productId, String sku) {
        List<MarketplaceListing> allListings = listingRepository.findByProductId(productId);

        for (MarketplaceListing listing : allListings) {
            if (listing.getMarketplaceType() == MarketplaceType.SHOPIFY) continue;

            switch (listing.getListingStatus()) {
                case ACTIVE -> {
                    // Real listing on the marketplace — must delist it
                    String key = "exclude-delist-" + listing.getId();
                    syncJobProducer.enqueue(SyncJob.builder()
                        .jobType(SyncJobType.LISTING_DELIST)
                        .marketplaceType(listing.getMarketplaceType())
                        .marketplaceAccountId(listing.getMarketplaceAccountId())
                        .productId(productId)
                        .listingId(listing.getId())
                        .payload(java.util.Map.of("reason", "marketplace_excluded"))
                        .idempotencyKey(key)
                        .build());
                    log.info("Queued LISTING_DELIST for {} listing {} (product {} excluded)",
                        listing.getMarketplaceType(), listing.getId(), sku);
                }
                case NEEDS_REVIEW, PENDING, FAILED, INACTIVE, DELISTED -> {
                    // Never published or already off-market — just delete the stub
                    listingRepository.delete(listing);
                    log.info("Deleted {} listing stub {} (status={}) for excluded product {}",
                        listing.getMarketplaceType(), listing.getId(),
                        listing.getListingStatus(), sku);
                }
                case PUBLISHING -> {
                    // In-flight publish — mark as failed and let the publish job error naturally;
                    // the delist guard in the webhook processor will prevent re-creation.
                    listing.setListingStatus(ListingStatus.FAILED);
                    listing.setLastError("Product excluded from marketplaces while publish was in progress.");
                    listingRepository.save(listing);
                    log.warn("Product {} excluded while listing {} was PUBLISHING — marked FAILED",
                        sku, listing.getId());
                }
                case SOLD -> {
                    // Completed sale — historical record, leave it alone
                }
            }
        }
    }
}
