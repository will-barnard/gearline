package com.gearline.service;

import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.order.OrderLineItem;
import com.gearline.domain.product.Product;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.MarketplaceListingRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.infrastructure.messaging.SyncJobProducer;
import com.gearline.marketplace.common.dto.ImportedOrder;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

/**
 * Enforces inventory consistency across all connected marketplace channels.
 * When inventory changes on one channel, this service propagates the update
 * to all other active listings to prevent overselling.
 *
 * Uses optimistic locking on Product.version — concurrent updates are retried.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class InventoryConsistencyService {

    private final ProductRepository productRepository;
    private final MarketplaceListingRepository listingRepository;
    private final MarketplaceAccountRepository accountRepository;
    private final SyncJobProducer syncJobProducer;

    /**
     * Called when a product's quantity changes (Shopify webhook, manual update, etc.)
     * Propagates the new quantity to all active marketplace listings.
     */
    @Transactional
    @Retryable(
        retryFor = ObjectOptimisticLockingFailureException.class,
        maxAttempts = 3,
        backoff = @Backoff(delay = 100, multiplier = 2)
    )
    public void propagateInventoryChange(Product product, int newQuantity) {
        log.info("Propagating inventory change for product {} to qty={}", product.getSku(), newQuantity);

        product.setQuantity(newQuantity);
        productRepository.save(product);

        List<MarketplaceListing> activeListings = listingRepository.findActiveListingsForProduct(product.getId());
        log.debug("Enqueueing inventory sync for {} active listings", activeListings.size());

        for (MarketplaceListing listing : activeListings) {
            SyncJob job = SyncJob.builder()
                .jobType(SyncJobType.INVENTORY_SYNC)
                .marketplaceType(listing.getMarketplaceType())
                .marketplaceAccountId(listing.getMarketplaceAccountId())
                .productId(product.getId())
                .listingId(listing.getId())
                .payload(Map.of("newQuantity", newQuantity))
                .idempotencyKey("inv-" + product.getId() + "-" + listing.getId() + "-" + System.currentTimeMillis())
                .build();

            syncJobProducer.enqueue(job);
        }
    }

    /**
     * Called when an order is imported from a marketplace.
     * Deducts sold quantity and triggers cross-channel inventory propagation.
     */
    @Transactional
    public void handleOrderImported(ImportedOrder importedOrder, MarketplaceAccount sourceAccount) {
        for (OrderLineItem lineItem : importedOrder.getLineItems()) {
            if (lineItem.getProductId() == null) continue;

            productRepository.findById(lineItem.getProductId()).ifPresent(product -> {
                int newQty = Math.max(0, product.getQuantity() - lineItem.getQuantity());
                log.info("Order imported: reducing product {} quantity {} -> {}",
                    product.getSku(), product.getQuantity(), newQty);
                propagateInventoryChange(product, newQty);
            });
        }
    }
}
