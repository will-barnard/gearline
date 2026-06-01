package com.gearline.marketplace.shopify.webhook;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.domain.product.ProductStatus;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.infrastructure.messaging.SyncJobProducer;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.MarketplaceListingRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.infrastructure.persistence.SyncJobRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.service.InventoryConsistencyService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

/**
 * Processes Shopify webhook payloads asynchronously.
 * All handlers are idempotent — safe to call multiple times with the same payload.
 *
 * ── Manual publish gate ──────────────────────────────────────────────────────
 *
 * Marketplace publishing is intentionally NOT automatic.
 *
 * When Shopify signals that a product was created or updated, Gearline:
 *   1. Upserts the local Product record with the latest Shopify data.
 *   2. Creates or flags MarketplaceListing rows in NEEDS_REVIEW status for every
 *      connected non-Shopify marketplace account.
 *
 * The user reviews the listing configuration in the dashboard, adjusts any
 * overrides (title, category, shipping profile, etc.), then manually clicks
 * Publish. Only at that point does a LISTING_PUBLISH job enter the queue.
 *
 * Automatic operations (no review required):
 *   - inventory_levels/update  → immediate cross-channel inventory propagation
 *   - orders/create            → immediate order import and inventory deduction
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ShopifyWebhookProcessor {

    private final ObjectMapper objectMapper;
    private final ProductRepository productRepository;
    private final MarketplaceListingRepository listingRepository;
    private final MarketplaceAccountRepository accountRepository;
    private final SyncJobRepository syncJobRepository;
    private final SyncJobProducer syncJobProducer;
    private final InventoryConsistencyService inventoryConsistencyService;

    @Async
    public void processAsync(String topic, String shopDomain, byte[] rawBody) {
        try {
            switch (topic) {
                case "inventory_levels/update" -> processInventoryLevelUpdate(shopDomain, rawBody);
                case "products/update"         -> processProductUpdate(shopDomain, rawBody);
                case "products/create"         -> processProductCreate(shopDomain, rawBody);
                case "orders/create"           -> processOrderCreate(shopDomain, rawBody);
                default -> log.debug("Unhandled Shopify webhook topic: {}", topic);
            }
        } catch (Exception e) {
            log.error("Error processing Shopify webhook topic={} shop={}: {}", topic, shopDomain, e.getMessage(), e);
        }
    }

    // ── inventory_levels/update — auto-propagate immediately ──────────────────

    @Transactional
    protected void processInventoryLevelUpdate(String shopDomain, byte[] rawBody) throws Exception {
        JsonNode payload = objectMapper.readTree(rawBody);
        String inventoryItemId = payload.path("inventory_item_id").asText();
        int available = payload.path("available").asInt(0);

        log.info("Shopify inventory_levels/update: item={} available={} shop={}", inventoryItemId, available, shopDomain);

        String idempotencyKey = "shopify-inv-" + inventoryItemId + "-" + payload.path("updated_at").asText();
        if (syncJobRepository.existsByIdempotencyKey(idempotencyKey)) {
            log.debug("Skipping duplicate inventory webhook for item {}", inventoryItemId);
            return;
        }

        productRepository.findByShopifyInventoryItemId(inventoryItemId).ifPresent(product ->
            inventoryConsistencyService.propagateInventoryChange(product, Math.max(0, available))
        );
    }

    // ── products/create — upsert product, flag listings for review ────────────

    @Transactional
    protected void processProductCreate(String shopDomain, byte[] rawBody) throws Exception {
        JsonNode payload = objectMapper.readTree(rawBody);
        String shopifyProductId = payload.path("id").asText();

        log.info("Shopify products/create: productId={} shop={}", shopifyProductId, shopDomain);

        // Upsert the Product record
        Product product = productRepository.findByShopifyProductId(shopifyProductId)
            .orElseGet(() -> buildProductFromPayload(payload));
        applyProductFields(product, payload);
        product = productRepository.save(product);

        // Create NEEDS_REVIEW listings for every active non-Shopify marketplace account
        final Product savedProduct = product;
        List<MarketplaceAccount> accounts = accountRepository.findByActiveTrue().stream()
            .filter(a -> a.getMarketplaceType() != MarketplaceType.SHOPIFY)
            .toList();

        for (MarketplaceAccount account : accounts) {
            // Idempotent — only create if one doesn't already exist for this product+account
            if (listingRepository.findByProductIdAndMarketplaceAccountId(
                    savedProduct.getId(), account.getId()).isEmpty()) {

                MarketplaceListing listing = MarketplaceListing.builder()
                    .productId(savedProduct.getId())
                    .marketplaceAccountId(account.getId())
                    .marketplaceType(account.getMarketplaceType())
                    .listingStatus(ListingStatus.NEEDS_REVIEW)
                    .build();
                listingRepository.save(listing);

                log.info("Created NEEDS_REVIEW listing for product {} on {} account {}",
                    savedProduct.getSku(), account.getMarketplaceType(), account.getId());
            }
        }
    }

    // ── products/update — update product, flag active listings for re-review ──

    @Transactional
    protected void processProductUpdate(String shopDomain, byte[] rawBody) throws Exception {
        JsonNode payload = objectMapper.readTree(rawBody);
        String shopifyProductId = payload.path("id").asText();

        log.info("Shopify products/update: productId={} shop={}", shopifyProductId, shopDomain);

        productRepository.findByShopifyProductId(shopifyProductId).ifPresent(product -> {
            applyProductFields(product, payload);
            productRepository.save(product);

            // Transition ACTIVE listings to NEEDS_REVIEW so the user can verify the
            // changes look correct before the updated data is pushed to the marketplace.
            // PENDING / FAILED listings are unchanged — they haven't been published yet.
            List<MarketplaceListing> activeListings =
                listingRepository.findByProductIdAndListingStatus(product.getId(), ListingStatus.ACTIVE);

            for (MarketplaceListing listing : activeListings) {
                listing.setListingStatus(ListingStatus.NEEDS_REVIEW);
                listingRepository.save(listing);
                log.info("Flagged listing {} ({}) as NEEDS_REVIEW after product update",
                    listing.getId(), listing.getMarketplaceType());
            }
        });
    }

    // ── orders/create — auto-process immediately ──────────────────────────────

    @Transactional
    protected void processOrderCreate(String shopDomain, byte[] rawBody) throws Exception {
        JsonNode payload = objectMapper.readTree(rawBody);
        String orderId = payload.path("id").asText();

        log.info("Shopify orders/create: orderId={} shop={}", orderId, shopDomain);

        accountRepository
            .findByMarketplaceTypeAndActiveTrue(MarketplaceType.SHOPIFY)
            .stream()
            .findFirst()
            .ifPresent(account -> {
                SyncJob job = SyncJob.builder()
                    .jobType(SyncJobType.ORDER_IMPORT)
                    .marketplaceType(MarketplaceType.SHOPIFY)
                    .marketplaceAccountId(account.getId())
                    .payload(Map.of("externalOrderId", orderId))
                    .idempotencyKey("shopify-order-create-" + orderId)
                    .build();

                if (!syncJobRepository.existsByIdempotencyKey(job.getIdempotencyKey())) {
                    syncJobProducer.enqueue(job);
                }
            });
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /**
     * Builds a new Product shell from a Shopify products/create payload.
     * Extracts from the first variant; multi-variant products are treated as
     * separate SKUs if they arrive as separate Shopify variants in future.
     */
    private Product buildProductFromPayload(JsonNode payload) {
        JsonNode variant = payload.path("variants").path(0);

        String sku = variant.path("sku").asText();
        if (sku.isBlank()) {
            // Fall back to shopify product ID as SKU if the store hasn't set one
            sku = "SHOPIFY-" + payload.path("id").asText();
        }

        BigDecimal price = BigDecimal.ZERO;
        String priceStr = variant.path("price").asText();
        if (!priceStr.isBlank()) {
            try { price = new BigDecimal(priceStr); } catch (NumberFormatException ignored) {}
        }

        int qty = variant.path("inventory_quantity").asInt(0);

        return Product.builder()
            .sku(sku)
            .title(payload.path("title").asText("Untitled Product"))
            .price(price)
            .quantity(Math.max(0, qty))
            .condition(ProductCondition.USED) // sensible default; user can override
            .status(ProductStatus.ACTIVE)
            .shopifyProductId(payload.path("id").asText())
            .shopifyVariantId(variant.path("id").asText())
            .shopifyInventoryItemId(variant.path("inventory_item_id").asText())
            .build();
    }

    /**
     * Updates mutable Product fields from a Shopify webhook payload.
     * Shopify IDs are never changed here; they were set at creation.
     */
    private void applyProductFields(Product product, JsonNode payload) {
        if (payload.has("title") && !payload.path("title").asText().isBlank()) {
            product.setTitle(payload.path("title").asText());
        }
        if (payload.has("body_html")) {
            product.setDescription(payload.path("body_html").asText());
        }
        if (payload.has("vendor") && !payload.path("vendor").asText().isBlank()) {
            product.setBrand(payload.path("vendor").asText());
        }
        // Update price and quantity from first variant if present
        JsonNode variant = payload.path("variants").path(0);
        if (!variant.isMissingNode()) {
            String priceStr = variant.path("price").asText();
            if (!priceStr.isBlank()) {
                try { product.setPrice(new BigDecimal(priceStr)); } catch (NumberFormatException ignored) {}
            }
            int qty = variant.path("inventory_quantity").asInt(Integer.MIN_VALUE);
            if (qty != Integer.MIN_VALUE) {
                product.setQuantity(Math.max(0, qty));
            }
        }

        // Images — extract src URLs from Shopify's images array, sorted by position.
        // These flow through to Reverb (photos) and eBay (product.imageUrls) at publish time.
        JsonNode images = payload.path("images");
        if (images.isArray() && !images.isEmpty()) {
            List<String> urls = new java.util.ArrayList<>();
            images.forEach(img -> {
                String src = img.path("src").asText();
                if (!src.isBlank()) urls.add(src);
            });
            if (!urls.isEmpty()) {
                product.setImageUrls(urls);
            }
        }
    }
}
