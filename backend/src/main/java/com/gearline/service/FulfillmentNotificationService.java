package com.gearline.service;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.order.Order;
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
 * ── Finding #16 fix: don't mark SHIPPED on API failure ───────────────────────
 *
 * The previous catch block called {@code updateOrderTracking()} unconditionally,
 * marking the order as SHIPPED even when the marketplace API call had just thrown
 * an exception. This made the order appear shipped in Gearline even though Reverb
 * or eBay had no idea — the buyer never received a tracking notification.
 *
 * Fix: in the catch block we still persist the local tracking fields (carrier,
 * number, URL) so they're not lost, but we do NOT advance the order status to
 * SHIPPED. The order remains in its previous status so the operator knows the
 * marketplace notification needs attention.
 *
 * ── Finding #29 fix: use actual fulfilment date ───────────────────────────────
 *
 * The eBay shippingFulfillment API requires a {@code shippedDate}. Previously this
 * was set to {@code Instant.now()} (the time the webhook was processed), which could
 * be minutes or hours after the actual shipment. Now we accept the fulfilment
 * {@code createdAt} timestamp from the Shopify webhook and pass it to eBay.
 * We fall back to {@code Instant.now()} only when the date is unavailable.
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
     * @param shopifyOrderId   the Shopify order ID extracted from the webhook payload
     * @param trackingNumber   carrier tracking number (may be null if not yet known)
     * @param trackingCarrier  carrier name from Shopify (e.g. "USPS", "UPS", "FedEx")
     * @param trackingUrl      carrier tracking URL (may be null)
     * @param fulfilledAt      actual fulfilment timestamp from Shopify (may be null)
     */
    @Transactional
    public void notifyMarketplace(String shopifyOrderId, String trackingNumber,
                                   String trackingCarrier, String trackingUrl,
                                   Instant fulfilledAt) {
        if (shopifyOrderId == null || shopifyOrderId.isBlank()) {
            log.warn("fulfillments/create received with no order_id — ignoring");
            return;
        }

        Optional<Order> orderOpt = orderRepository.findByShopifyOrderId(shopifyOrderId);
        if (orderOpt.isEmpty()) {
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
            markShipped(order, trackingNumber, trackingCarrier, trackingUrl, fulfilledAt);
            return;
        }

        Optional<MarketplaceAccount> accountOpt = accountRepository.findById(order.getMarketplaceAccountId());
        if (accountOpt.isEmpty()) {
            log.error("Cannot notify marketplace for order {}: account {} not found",
                order.getId(), order.getMarketplaceAccountId());
            return;
        }

        MarketplaceAccount account = accountOpt.get();
        String externalOrderId = order.getExternalOrderId();
        Instant shippedDate = fulfilledAt != null ? fulfilledAt : Instant.now();

        try {
            switch (order.getMarketplaceType()) {
                case REVERB -> notifyReverb(account, externalOrderId, trackingNumber, trackingCarrier);
                case EBAY   -> notifyEbay(account, externalOrderId, order, trackingNumber, trackingCarrier,
                                          shippedDate);
                default     -> log.warn("No fulfillment notification handler for marketplace type: {}",
                                  order.getMarketplaceType());
            }

            // Marketplace notified successfully — mark SHIPPED
            markShipped(order, trackingNumber, trackingCarrier, trackingUrl, shippedDate);
            log.info("Notified {} of shipment for order {} (tracking: {})",
                order.getMarketplaceType(), externalOrderId, trackingNumber);

        } catch (Exception e) {
            log.error("Failed to notify {} of shipment for order {}: {}",
                order.getMarketplaceType(), externalOrderId, e.getMessage(), e);

            // Finding #16: persist tracking details locally but do NOT mark SHIPPED —
            // the marketplace was not successfully notified.
            // The operator can investigate and retry from the orders page.
            saveTrackingOnly(order, trackingNumber, trackingCarrier, trackingUrl);
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
                             String trackingNumber, String carrier, Instant shippedDate) {
        log.info("Notifying eBay of shipment for order {} (carrier={}, tracking={}, shippedDate={})",
            orderId, carrier, trackingNumber, shippedDate);

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
            shippedDate.toString()   // Finding #29: actual fulfilment date, not Instant.now()
        );
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /** Marks the order as SHIPPED and saves all tracking fields. */
    private void markShipped(Order order, String trackingNumber, String trackingCarrier,
                              String trackingUrl, Instant fulfilledAt) {
        order.setTrackingNumber(trackingNumber);
        order.setTrackingCarrier(trackingCarrier);
        order.setTrackingUrl(trackingUrl);
        order.setOrderStatus(OrderStatus.SHIPPED);
        order.setFulfilledAt(fulfilledAt != null ? fulfilledAt : Instant.now());
        orderRepository.save(order);
    }

    /**
     * Saves tracking fields without changing the order status.
     * Used when the marketplace notification failed — we record the tracking
     * data locally but leave the order in its current status so the operator
     * knows the notification still needs to be sent.
     */
    private void saveTrackingOnly(Order order, String trackingNumber,
                                   String trackingCarrier, String trackingUrl) {
        order.setTrackingNumber(trackingNumber);
        order.setTrackingCarrier(trackingCarrier);
        order.setTrackingUrl(trackingUrl);
        // Intentionally NOT setting OrderStatus.SHIPPED or fulfilledAt
        orderRepository.save(order);
    }
}
