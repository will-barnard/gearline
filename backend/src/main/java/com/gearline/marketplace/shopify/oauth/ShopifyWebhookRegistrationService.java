package com.gearline.marketplace.shopify.oauth;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.marketplace.shopify.client.ShopifyApiClient;
import com.gearline.marketplace.shopify.client.ShopifyApiException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Registers Gearline's webhook subscriptions on a Shopify store immediately
 * after OAuth completes.
 *
 * Shopify delivers these events to Gearline's webhook endpoints:
 *
 *   products/create          → /webhooks/shopify/products/create
 *   products/update          → /webhooks/shopify/products/update
 *   inventory_levels/update  → /webhooks/shopify/inventory-levels/update
 *   orders/create            → /webhooks/shopify/orders/create
 *
 * Each webhook call is fire-and-forget — a registration failure is logged but
 * does NOT roll back the OAuth connection.  Webhooks can be re-registered by
 * disconnecting and reconnecting the store.
 *
 * Shopify deduplicates webhooks by topic+address, so calling this multiple
 * times for the same store is safe.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ShopifyWebhookRegistrationService {

    private final ShopifyApiClient shopifyApiClient;
    private final GearlineProperties properties;

    /** Webhook topics Gearline needs from Shopify. */
    private static final List<String> WEBHOOK_TOPICS = List.of(
        "products/create",
        "products/update",
        "inventory_levels/update",
        "orders/create",
        "fulfillments/create"   // → forward tracking info to Reverb/eBay
    );

    /**
     * Registers all required webhook subscriptions on the given Shopify store.
     * Called once immediately after OAuth token exchange completes.
     *
     * @param account the freshly-connected Shopify MarketplaceAccount
     */
    public void registerAll(MarketplaceAccount account) {
        String baseUrl = properties.getApp().getBaseUrl();
        if (baseUrl == null || baseUrl.isBlank()) {
            log.warn("APP_BASE_URL is not configured — cannot register Shopify webhooks. " +
                "Set APP_BASE_URL to your public-facing URL and reconnect the store.");
            return;
        }

        for (String topic : WEBHOOK_TOPICS) {
            registerOne(account, topic, baseUrl);
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private void registerOne(MarketplaceAccount account, String topic, String baseUrl) {
        // Map topic to our endpoint path: "products/create" → "/webhooks/shopify/products/create"
        // "inventory_levels/update" → "/webhooks/shopify/inventory-levels/update"
        String path = topicToPath(topic);
        String endpoint = baseUrl.replaceAll("/$", "") + path;

        try {
            shopifyApiClient.registerWebhook(account, topic, endpoint);
            log.info("Registered Shopify webhook: {} → {}", topic, endpoint);
        } catch (ShopifyApiException e) {
            // Non-fatal — log and continue with remaining topics
            log.error("Failed to register Shopify webhook '{}': {}", topic, e.getMessage());
        }
    }

    /**
     * Converts a Shopify topic string to our webhook endpoint path.
     * Shopify uses slashes (products/create); our paths use hyphens for the resource
     * segment when it contains underscores (inventory_levels → inventory-levels).
     */
    private String topicToPath(String topic) {
        return switch (topic) {
            case "products/create"         -> "/webhooks/shopify/products/create";
            case "products/update"         -> "/webhooks/shopify/products/update";
            case "inventory_levels/update" -> "/webhooks/shopify/inventory-levels/update";
            case "orders/create"           -> "/webhooks/shopify/orders/create";
            case "fulfillments/create"     -> "/webhooks/shopify/fulfillments/create";
            default -> "/webhooks/shopify/" + topic.replace("/", "/");
        };
    }
}
