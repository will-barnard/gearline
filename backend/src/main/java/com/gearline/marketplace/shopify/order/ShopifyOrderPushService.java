package com.gearline.marketplace.shopify.order;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.order.Order;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.OrderRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.common.dto.ImportedOrder;
import com.gearline.marketplace.shopify.client.ShopifyApiClient;
import com.gearline.marketplace.shopify.client.ShopifyApiException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;
import java.util.Optional;

/**
 * Mirrors a Reverb or eBay order into Shopify so it appears on the store's
 * Orders page alongside native Shopify sales.
 *
 * ── Why push to Shopify? ─────────────────────────────────────────────────────
 *
 * Shopify is the merchant's system of record for fulfilment, accounting, and
 * customer history. By creating a corresponding order there, the merchant can:
 *   - Print packing slips and shipping labels from Shopify
 *   - See unified revenue across all channels
 *   - Trigger Shopify Flows (e.g. notify warehouse)
 *   - Use Shopify's built-in customer profiles
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *
 * {@code Order.shopifyOrderId} tracks whether a push has occurred.
 * If it is already set, we skip the push silently.  This makes it safe to
 * call this method multiple times for the same order (e.g. retries).
 *
 * ── Graceful degradation ─────────────────────────────────────────────────────
 *
 * If no Shopify account is connected, or the push fails, we log a warning and
 * continue.  The Reverb/eBay order is still saved in Gearline regardless.
 * Failed pushes can be retried later via the admin dashboard (future work).
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ShopifyOrderPushService {

    private final ShopifyApiClient shopifyApiClient;
    private final ShopifyOrderMapper shopifyOrderMapper;
    private final MarketplaceAccountRepository accountRepository;
    private final OrderRepository orderRepository;

    /**
     * Pushes an imported marketplace order into Shopify and records the
     * resulting Shopify order ID on the saved {@link Order} entity.
     *
     * @param order         the persisted Gearline Order (will be updated with shopifyOrderId)
     * @param importedOrder the normalised order data from the source marketplace
     * @param sourceType    REVERB or EBAY — used for tags/source_name on the Shopify order
     */
    @Transactional
    public void pushToShopify(Order order, ImportedOrder importedOrder, MarketplaceType sourceType) {

        // ── 1. Already pushed? Skip ───────────────────────────────────────────
        if (order.getShopifyOrderId() != null) {
            log.debug("Order {} already pushed to Shopify (shopify_order_id={}), skipping",
                order.getId(), order.getShopifyOrderId());
            return;
        }

        // ── 2. Is a Shopify account connected? ────────────────────────────────
        Optional<MarketplaceAccount> shopifyAccount = accountRepository
            .findByMarketplaceTypeAndActiveTrue(MarketplaceType.SHOPIFY)
            .stream()
            .findFirst();

        if (shopifyAccount.isEmpty()) {
            log.info("No active Shopify account connected — skipping order push for order {}", order.getId());
            return;
        }

        // ── 3. Guard: skip push when there are no line items ─────────────────
        // Finding #30: the mapper no longer inserts a $0 placeholder for empty
        // line-item lists. If the imported order genuinely has no line items we
        // must not push — Shopify rejects orders with an empty line_items array,
        // and a $0 placeholder would corrupt analytics anyway.
        if (importedOrder.getLineItems() == null || importedOrder.getLineItems().isEmpty()) {
            log.warn("Skipping Shopify push for {} order {} — no line items",
                sourceType, importedOrder.getExternalOrderId());
            return;
        }

        // ── 4. Build request and call Admin API ───────────────────────────────
        Map<String, Object> body = shopifyOrderMapper.toShopifyOrderBody(importedOrder, sourceType);

        try {
            Map<String, Object> response = shopifyApiClient.createOrder(shopifyAccount.get(), body);

            // Extract the Shopify order ID from the response
            String shopifyOrderId = extractShopifyOrderId(response);
            if (shopifyOrderId != null) {
                order.setShopifyOrderId(shopifyOrderId);
                orderRepository.save(order);
                log.info("Pushed {} order {} to Shopify → shopify_order_id={}",
                    sourceType, importedOrder.getExternalOrderId(), shopifyOrderId);
            } else {
                log.warn("Shopify order created but could not parse order ID from response for order {}",
                    order.getId());
            }

        } catch (ShopifyApiException e) {
            // Non-fatal: the Gearline order is already saved; log and move on.
            // A future task can retry failed pushes from the orders page.
            log.error("Failed to push {} order {} to Shopify: {}",
                sourceType, importedOrder.getExternalOrderId(), e.getMessage());
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /**
     * Extracts the Shopify order ID (numeric string) from the API response.
     * Shopify returns: {"order": {"id": 1234567890, "name": "#1001", ...}}
     */
    @SuppressWarnings("unchecked")
    private String extractShopifyOrderId(Map<String, Object> response) {
        if (response == null) return null;
        Object orderNode = response.get("order");
        if (orderNode instanceof Map<?, ?> orderMap) {
            Object id = orderMap.get("id");
            return id != null ? id.toString() : null;
        }
        return null;
    }
}
