package com.gearline.service;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.order.Order;
import com.gearline.domain.order.OrderLineItem;
import com.gearline.domain.order.OrderStatus;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.OrderRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.ebay.client.EbayApiClient;
import com.gearline.marketplace.reverb.client.ReverbApiClient;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Forwards Shopify fulfillment/shipping information back to the originating
 * marketplace (Reverb or eBay) when a merchant marks an order as shipped in Shopify.
 *
 * ── Flow ─────────────────────────────────────────────────────────────────────
 *
 *   1. Merchant adds tracking info and marks fulfilment in Shopify.
 *   2. Shopify fires a {@code fulfillments/create} webhook.
 *   3. {@link com.gearline.marketplace.shopify.webhook.ShopifyWebhookProcessor}
 *      calls {@link #notifyMarketplace} with the fulfilment payload.
 *   4. We look up the Gearline Order by its mirrored {@code shopifyOrderId}.
 *   5. If the source is REVERB or EBAY we call the appropriate API to mark the
 *      order as shipped with the tracking details.
 *   6. The order record is updated with tracking fields and status SHIPPED.
 *
 * ── Shopify-native orders ─────────────────────────────────────────────────────
 *
 * Orders originating from Shopify itself (marketplace_type = SHOPIFY) are
 * ignored here — there is no corresponding external marketplace to notify.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *
 * If the order is already in SHIPPED status the notification is skipped.
 * Shopify may occasionally fire duplicate webhook deliveries; this guards
 * against double-notifying the marketplace.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class FulfillmentNotificationService {

    private final OrderRepository orderRepository;
    private final MarketplaceAccountRepository accountRepository;
    private final ReverbApiClient reverbApiClient;
    private final EbayApiClient ebayApiClient;

    /**
     * Processes a Shopify fulfilment event and forwards shipping details to the
     * originating marketplace.
     *
     * @param shopifyOrderId  the Shopify order ID extracted from the webhook payload
     * @param trackingNumber  carrier tracking number (may be null if not yet known)
     * @param trackingCarrier carrier name from Shopify (e.g. "USPS", "UPS", "FedEx")
     * @param trackingUrl     carrier tracking URL (may be null)
     */
    @Transactional
    public void notifyMarketplace(String shopifyOrderId, String trackingNumber,
                                   String trackingCarrier, String trackingUrl) {
        if (shopifyOrderId == null || shopifyOrderId.isBlank()) {
            log.warn("fulfillments/create received with no order_id — ignoring");
            return;
        }

        Optional<Order> orderOpt = orderRepository.findByShopifyOrderId(shopifyOrderId);
        if (orderOpt.isEmpty()) {
            // The shopify order_id may belong to a native Shopify order (not pushed from
            // Reverb/eBay). There's no Order entity in that case — nothing to do.
            log.debug("No Gearline order found for shopify_order_id={} — probably a native Shopify order, skipping",
                shopifyOrderId);
            return;
        }

        Order order = orderOpt.get();

        // Idempotency: already processed?
        if (order.getOrderStatus() == OrderStatus.SHIPPED) {
            log.debug("Order {} already marked SHIPPED — skipping duplicate fulfillment webhook", order.getId());
            return;
        }

        // Native Shopify orders have no external marketplace to notify
        if (order.getMarketplaceType() == MarketplaceType.SHOPIFY) {
            log.debug("Order {} is a Shopify-native order — no external marketplace to notify", order.getId());
            updateOrderTracking(order, trackingNumber, trackingCarrier, trackingUrl);
            return;
        }

        // Resolve the marketplace account
        Optional<MarketplaceAccount> accountOpt = accountRepository.findById(order.getMarketplaceAccountId());
        if (accountOpt.isEmpty()) {
            log.error("Cannot notify marketplace for order {}: account {} not found",
                order.getId(), order.getMarketplaceAccountId());
            return;
        }

        MarketplaceAccount account = accountOpt.get();
        String externalOrderId = order.getExternalOrderId();

        try {
            switch (order.getMarketplaceType()) {
                case REVERB -> notifyReverb(account, externalOrderId, trackingNumber, trackingCarrier);
                case EBAY   -> notifyEbay(account, externalOrderId, order, trackingNumber, trackingCarrier);
                default     -> log.warn("No fulfillment notification handler for marketplace type: {}",
                                  order.getMarketplaceType());
            }

            // Persist tracking info and mark SHIPPED
            updateOrderTracking(order, trackingNumber, trackingCarrier, trackingUrl);
            log.info("Notified {} of shipment for order {} (tracking: {})",
                order.getMarketplaceType(), externalOrderId, trackingNumber);

        } catch (Exception e) {
            log.error("Failed to notify {} of shipment for order {}: {}",
                order.getMarketplaceType(), externalOrderId, e.getMessage(), e);
            // Do NOT re-throw — we still want to persist tracking info locally even if
            // the marketplace call fails. Operator can retry manually if needed.
            updateOrderTracking(order, trackingNumber, trackingCarrier, trackingUrl);
        }
    }

    // ── Marketplace-specific notification ─────────────────────────────────────

    private void notifyReverb(MarketplaceAccount account, String orderId,
                               String trackingNumber, String carrier) {
        log.info("Notifying Reverb of shipment for order {} (carrier={}, tracking={})",
            orderId, carrier, trackingNumber);
        reverbApiClient.markOrderShipped(account, orderId, trackingNumber, carrier);
    }

    private void notifyEbay(MarketplaceAccount account, String orderId, Order order,
                             String trackingNumber, String carrier) {
        log.info("Notifying eBay of shipment for order {} (carrier={}, tracking={})",
            orderId, carrier, trackingNumber);

        // Build the lineItems array for the eBay shippingFulfillment request.
        // Each item's externalListingId holds the eBay lineItemId captured at import time.
        List<Map<String, Object>> lineItems = order.getLineItems().stream()
            .filter(li -> li.getExternalListingId() != null)
            .map(li -> Map.<String, Object>of(
                "lineItemId", li.getExternalListingId(),
                "quantity", li.getQuantity() != null ? li.getQuantity() : 1
            ))
            .toList();

        if (lineItems.isEmpty()) {
            log.warn("eBay order {} has no line items with externalListingId — cannot build fulfillment payload",
                orderId);
        }

        ebayApiClient.markOrderShipped(
            account, orderId, lineItems, trackingNumber, carrier,
            Instant.now().toString()
        );
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private void updateOrderTracking(Order order, String trackingNumber,
                                      String trackingCarrier, String trackingUrl) {
        order.setTrackingNumber(trackingNumber);
        order.setTrackingCarrier(trackingCarrier);
        order.setTrackingUrl(trackingUrl);
        order.setOrderStatus(OrderStatus.SHIPPED);
        order.setFulfilledAt(Instant.now());
        orderRepository.save(order);
    }
}
