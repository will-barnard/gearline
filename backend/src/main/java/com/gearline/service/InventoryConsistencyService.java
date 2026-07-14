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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
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
 *
 * ── Finding #5: @Retryable + same-bean call ──────────────────────────────────
 *
 * Spring AOP proxies only intercept calls made through the proxy (i.e. via an
 * injected reference to the bean), not direct {@code this.method()} calls within
 * the same class. {@link #handleOrderImported} previously called
 * {@code propagateInventoryChange()} directly, bypassing the @Retryable proxy.
 *
 * Fix: inject a self-reference {@code self} with @Lazy to avoid circular-dependency
 * issues at startup. Calls through {@code self} go through the full proxy chain, so
 * both @Retryable and @Transactional are active.
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
     * Self-reference injected via @Lazy to allow cross-cutting through the AOP proxy.
     * Used by handleOrderImported() so that the @Retryable on propagateInventoryChange()
     * is actually active (finding #5).
     */
    @Autowired
    @Lazy
    private InventoryConsistencyService self;

    /**
     * Called when a product's quantity changes (Shopify webhook, manual update, etc.)
     * Propagates the new quantity to all active marketplace listings.
     *
     * ── Zero-quantity behaviour ─────────────────────────────────────────────
     * When {@code newQuantity} reaches 0 the item has sold out. Instead of
     * sending a quantity-update (which leaves the listing visible at 0 stock),
     * we enqueue a {@code LISTING_DELIST} job so the item is completely removed
     * from each marketplace.
     *
     * Shopify listings are always skipped — inventory there is managed through
     * the webhook path and ShopifyConnector.syncInventory is intentionally a no-op.
     *
     * ── Finding #20: deterministic idempotency keys ──────────────────────────
     * Previously used System.currentTimeMillis() making the same event generate
     * different keys each time — defeating idempotency.  Now uses a key derived
     * from productId, listingId, quantity, and product.version so the same
     * inventory state always produces the same key, and changing state
     * (version increments on each product save) produces a new unique key.
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

        if (newQuantity == 0) {
            log.info("Product {} qty reached 0 — delisting from {} active channel(s)",
                product.getSku(), activeListings.size());
        } else {
            log.debug("Enqueueing inventory sync for {} active listings", activeListings.size());
        }

        // Use product version as part of the idempotency key so the same inventory event
        // fired twice produces the same key (skipped as duplicate), but a subsequent
        // inventory change (version incremented) produces a new unique key.
        Long version = product.getVersion() != null ? product.getVersion() : 0L;

        for (MarketplaceListing listing : activeListings) {
            if (listing.getMarketplaceType() == MarketplaceType.SHOPIFY) {
                log.debug("Skipping Shopify listing {} for inventory propagation (managed via webhook path)",
                    listing.getId());
                continue;
            }

            if (newQuantity == 0) {
                SyncJob job = SyncJob.builder()
                    .jobType(SyncJobType.LISTING_DELIST)
                    .marketplaceType(listing.getMarketplaceType())
                    .marketplaceAccountId(listing.getMarketplaceAccountId())
                    .productId(product.getId())
                    .listingId(listing.getId())
                    .payload(Map.of())
                    .idempotencyKey("delist-soldout-" + listing.getId() + "-v" + version)
                    .build();
                syncJobProducer.enqueue(job);
                log.info("Enqueued LISTING_DELIST for {} listing {} (product {} sold out)",
                    listing.getMarketplaceType(), listing.getId(), product.getSku());
            } else {
                SyncJob job = SyncJob.builder()
                    .jobType(SyncJobType.INVENTORY_SYNC)
                    .marketplaceType(listing.getMarketplaceType())
                    .marketplaceAccountId(listing.getMarketplaceAccountId())
                    .productId(product.getId())
                    .listingId(listing.getId())
                    .payload(Map.of("newQuantity", newQuantity))
                    .idempotencyKey("inv-" + product.getId() + "-" + listing.getId() + "-v" + version)
                    .build();
                syncJobProducer.enqueue(job);
            }
        }
    }

    /**
     * Called when an order is imported from a marketplace.
     * Deducts sold quantity and triggers cross-channel inventory propagation.
     *
     * Finding #5 fix: calls {@code self.propagateInventoryChange()} (through the
     * AOP proxy) instead of {@code this.propagateInventoryChange()} so that
     * @Retryable is active for optimistic-lock retries.
     */
    @Transactional
    public void handleOrderImported(ImportedOrder importedOrder, MarketplaceAccount sourceAccount) {
        for (OrderLineItem lineItem : importedOrder.getLineItems()) {
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

            // Use self reference so @Retryable proxy is active (finding #5)
            self.propagateInventoryChange(product, newQty);
        }
    }
}
