package com.gearline.marketplace.shopify.sync;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.marketplace.shopify.client.ShopifyApiClient;
import com.gearline.marketplace.shopify.client.ShopifyProductsPage;
import com.gearline.marketplace.shopify.webhook.ShopifyWebhookProcessor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

/**
 * Performs a one-off bulk import of all active products from a connected
 * Shopify store into Gearline.
 *
 * Gearline's normal product import path relies entirely on webhooks. Webhooks
 * only fire for future events — products that already existed in the store when
 * it was connected are never sent. This service fills that gap by paging through
 * the Shopify products list API and processing each product through the existing
 * {@link ShopifyWebhookProcessor#processProductCreate} logic, which is fully
 * idempotent (upserts the Product, skips listing creation if a listing already
 * exists for that product+account pair).
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ShopifyInitialSyncService {

    private final ShopifyApiClient shopifyApiClient;
    private final ShopifyWebhookProcessor webhookProcessor;
    private final ObjectMapper objectMapper;

    /**
     * Pages through all active Shopify products for the given account and
     * imports each one into Gearline. Runs asynchronously so the triggering
     * HTTP request returns immediately.
     *
     * @param account the connected Shopify MarketplaceAccount
     */
    @Async
    public void syncAllProducts(MarketplaceAccount account) {
        String shopDomain = account.getExternalShopUrl();
        log.info("Starting initial product sync for Shopify store: {}", shopDomain);

        int totalProcessed = 0;
        int totalErrors = 0;
        String pageInfo = null;

        try {
            do {
                ShopifyProductsPage page = shopifyApiClient.fetchProducts(account, pageInfo);

                for (JsonNode product : page.products()) {
                    try {
                        // Re-serialize to bytes so processProductCreate parses it
                        // exactly as it would a real webhook payload.
                        byte[] productBytes = objectMapper.writeValueAsBytes(product);
                        webhookProcessor.processProductCreate(shopDomain, productBytes);
                        totalProcessed++;
                    } catch (Exception e) {
                        totalErrors++;
                        log.error("Error importing product id={} during initial sync for {}: {}",
                            product.path("id").asText("?"), shopDomain, e.getMessage(), e);
                    }
                }

                log.info("Synced page ({} products, {} total so far) for store {}",
                    page.products().size(), totalProcessed, shopDomain);

                pageInfo = page.nextPageInfo();

            } while (pageInfo != null);

        } catch (Exception e) {
            log.error("Initial product sync failed for store {}: {}", shopDomain, e.getMessage(), e);
        }

        log.info("Initial product sync complete for {}: {} imported, {} errors",
            shopDomain, totalProcessed, totalErrors);
    }
}
