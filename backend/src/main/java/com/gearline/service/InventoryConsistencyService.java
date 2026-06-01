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
import com.gearline.marketplace.common.connector.MarketplaceType;
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
            // Shopify is the source-of-truth — its inventory is updated by ShopifyOrderPushService
            // when marketplace orders are imported, not via the sync job queue. Skipping here
            // prevents a connector-not-found error since ShopifyConnector.syncInventory is a no-op.
            if (listing.getMarketplaceType() == MarketplaceType.SHOPIFY) {
                log.debug("Skipping Shopify listing {} for inventory sync (managed via webhook path)",
                    listing.getId());
                continue;
            }

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
            // Resolve the product: prefer the internal UUID, fall back to SKU lookup.
            // Externally-imported orders (Reverb, eBay) populate sku but not productId
            // because the ID is only known after matching against our product catalogue.
            Product product = null;

            if (lineItem.getProductId() != null) {
                product = productRepository.findById(lineItem.getProductId()).orElse(null);
            } else if (lineItem.getSku() != null && !lineItem.getSku().isBlank()) {
                product = productRepository.findBySku(lineItem.getSku()).orElse(null);
                if (product == null) {
                    log.warn("Order imported but no product found for SKU '{}' — inventory not adjusted",
                        lineItem.getSku());
                }
            }

            if (product == null) continue;

            int qty = lineItem.getQuantity() != null ? lineItem.getQuantity() : 1;
            int newQty = Math.max(0, product.getQuantity() - qty);
            log.info("Order imported: reducing product {} quantity {} → {} (order from {})",
                product.getSku(), product.getQuantity(), newQty, sourceAccount.getMarketplaceType());
            propagateInventoryChange(product, newQty);
        }
    }
}
