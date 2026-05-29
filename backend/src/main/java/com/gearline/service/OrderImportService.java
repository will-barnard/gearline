package com.gearline.service;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.order.Order;
import com.gearline.domain.order.OrderStatus;
import com.gearline.infrastructure.persistence.OrderRepository;
import com.gearline.marketplace.common.dto.ImportedOrder;
import com.gearline.marketplace.shopify.order.ShopifyOrderPushService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

/**
 * Single entry-point for importing an order from any marketplace.
 *
 * Pipeline (for each imported order):
 *   1. Deduplication — skip if already imported (idempotent on external_order_id)
 *   2. Persist       — save the Order to the DB
 *   3. Inventory     — deduct sold quantity and propagate cross-channel
 *   4. Shopify push  — create a corresponding order in Shopify (gracefully skipped
 *                       if Shopify is not connected or the push was already done)
 *
 * This service is called both from the polling scheduler (batch import) and from
 * {@link SyncDispatcherService} when a single-order import job is dispatched.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderImportService {

    private final OrderRepository orderRepository;
    private final InventoryConsistencyService inventoryConsistencyService;
    private final ShopifyOrderPushService shopifyOrderPushService;

    /**
     * Imports a single order from a marketplace account.
     *
     * @param importedOrder the normalised order data from the connector
     * @param account       the marketplace account the order came from
     * @return the saved (or already-existing) Order entity, or null if a fatal error occurred
     */
    @Transactional
    public Order importOrder(ImportedOrder importedOrder, MarketplaceAccount account) {
        // ── 1. Deduplication ──────────────────────────────────────────────────
        if (orderRepository.existsByMarketplaceTypeAndExternalOrderId(
                account.getMarketplaceType(), importedOrder.getExternalOrderId())) {
            log.debug("Order {} from {} already imported — skipping",
                importedOrder.getExternalOrderId(), account.getMarketplaceType());
            return null;
        }

        // ── 2. Persist ────────────────────────────────────────────────────────
        Order order = Order.builder()
            .externalOrderId(importedOrder.getExternalOrderId())
            .marketplaceAccountId(account.getId())
            .marketplaceType(account.getMarketplaceType())
            .orderStatus(OrderStatus.IMPORTED)
            .lineItems(importedOrder.getLineItems())
            .subtotal(importedOrder.getSubtotal())
            .shippingTotal(importedOrder.getShippingTotal())
            .taxTotal(importedOrder.getTaxTotal())
            .totalAmount(importedOrder.getTotalAmount())
            .currency(importedOrder.getCurrency() != null ? importedOrder.getCurrency() : "USD")
            .buyerInfo(importedOrder.getBuyerInfo())
            .shippingAddress(importedOrder.getShippingAddress())
            .marketplaceOrderUrl(importedOrder.getMarketplaceOrderUrl())
            .importedAt(Instant.now())
            .build();

        order = orderRepository.save(order);
        log.info("Imported {} order {} (gearline id={})",
            account.getMarketplaceType(), importedOrder.getExternalOrderId(), order.getId());

        // ── 3. Inventory deduction ────────────────────────────────────────────
        try {
            inventoryConsistencyService.handleOrderImported(importedOrder, account);
        } catch (Exception e) {
            // Inventory failure must not prevent the order from being recorded
            log.error("Inventory deduction failed for order {}: {}",
                importedOrder.getExternalOrderId(), e.getMessage(), e);
        }

        // ── 4. Shopify push ───────────────────────────────────────────────────
        try {
            shopifyOrderPushService.pushToShopify(order, importedOrder, account.getMarketplaceType());
        } catch (Exception e) {
            // Shopify push failure must not prevent the order from being recorded
            log.error("Shopify push failed for order {}: {}",
                importedOrder.getExternalOrderId(), e.getMessage(), e);
        }

        return order;
    }
}
