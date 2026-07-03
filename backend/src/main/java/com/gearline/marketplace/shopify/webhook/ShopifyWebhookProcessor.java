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
import com.gearline.marketplace.shopify.client.ShopifyApiClient;
import com.gearline.service.FulfillmentNotificationService;
import com.gearline.service.InventoryConsistencyService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

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
 *   - inventory_levels/update  → immediate cross-channel inventory propagation (delist at qty=0)
 *   - products/update          → LISTING_UPDATE jobs fired for all ACTIVE listings
 *   - orders/create            → immediate order import and inventory deduction
 *   - fulfillments/create      → tracking info forwarded to Reverb/eBay via FulfillmentNotificationService
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
    private final FulfillmentNotificationService fulfillmentNotificationService;
    private final ShopifyApiClient shopifyApiClient;

    @Async
    public void processAsync(String topic, String shopDomain, byte[] rawBody) {
        try {
            switch (topic) {
                case "inventory_levels/update" -> processInventoryLevelUpdate(shopDomain, rawBody);
                case "products/update"         -> processProductUpdate(shopDomain, rawBody);
                case "products/create"         -> processProductCreate(shopDomain, rawBody);
                case "orders/create"           -> processOrderCreate(shopDomain, rawBody);
                case "fulfillments/create"     -> processFulfillmentCreate(shopDomain, rawBody);
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
    public void processProductCreate(String shopDomain, byte[] rawBody) throws Exception {
        JsonNode payload = objectMapper.readTree(rawBody);
        String shopifyProductId = payload.path("id").asText();

        log.info("Shopify products/create: productId={} shop={}", shopifyProductId, shopDomain);

        // Upsert the Product record
        Product product = productRepository.findByShopifyProductId(shopifyProductId)
            .orElseGet(() -> buildProductFromPayload(payload));
        applyProductFields(product, payload);
        applyMetafields(product, shopDomain, shopifyProductId);
        product = productRepository.save(product);

        // Don't create marketplace listings if the product has an excluded tag
        if (isExcludedByTags(payload, shopDomain)) {
            log.info("Product {} imported but not queued for marketplace listing — matches an excluded tag",
                product.getSku());
            return;
        }

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

    // ── products/update — update product, auto-push changes to active listings ─

    @Transactional
    protected void processProductUpdate(String shopDomain, byte[] rawBody) throws Exception {
        JsonNode payload = objectMapper.readTree(rawBody);
        String shopifyProductId = payload.path("id").asText();
        String shopifyStatus = payload.path("status").asText("active"); // "active" | "draft" | "archived"

        log.info("Shopify products/update: productId={} status={} shop={}", shopifyProductId, shopifyStatus, shopDomain);

        java.util.Optional<Product> maybeProduct = productRepository.findByShopifyProductId(shopifyProductId);

        // ── Product not yet in Gearline + now active → import it ─────────────
        //
        // This covers the draft→active transition for products that were NEVER
        // imported: the initial sync filters status=active, so any product that
        // was a draft at connect-time is absent from the DB. When it's made active
        // later, Shopify sends products/update (not products/create), so we must
        // fall through to create-semantics here or the product is silently lost.
        if (maybeProduct.isEmpty()) {
            if ("active".equals(shopifyStatus)) {
                log.info("Product {} not in Gearline yet but now active — importing via create path",
                    shopifyProductId);
                processProductCreate(shopDomain, rawBody);
            }
            // Draft/archived products that were never imported can stay that way.
            return;
        }

        Product product = maybeProduct.get();

        // ── Draft / archived in Shopify → archive in Gearline and delist ────
        if ("draft".equals(shopifyStatus) || "archived".equals(shopifyStatus)) {
            if (product.getStatus() != ProductStatus.ARCHIVED) {
                product.setStatus(ProductStatus.ARCHIVED);
                productRepository.save(product);
                log.info("Archived product {} because Shopify status changed to '{}'",
                    product.getSku(), shopifyStatus);
            }

            // Delist any active marketplace listings for this product
            List<MarketplaceListing> activeListings =
                listingRepository.findByProductIdAndListingStatus(product.getId(), ListingStatus.ACTIVE);

            for (MarketplaceListing listing : activeListings) {
                if (listing.getMarketplaceType() == MarketplaceType.SHOPIFY) continue;

                String idempotencyKey = "shopify-product-delist-" + shopifyProductId
                    + "-listing-" + listing.getId()
                    + "-" + payload.path("updated_at").asText(String.valueOf(System.currentTimeMillis()));

                if (!syncJobRepository.existsByIdempotencyKey(idempotencyKey)) {
                    syncJobProducer.enqueue(SyncJob.builder()
                        .jobType(SyncJobType.LISTING_DELIST)
                        .marketplaceType(listing.getMarketplaceType())
                        .marketplaceAccountId(listing.getMarketplaceAccountId())
                        .productId(product.getId())
                        .listingId(listing.getId())
                        .payload(Map.of("shopifyProductId", shopifyProductId, "reason", shopifyStatus))
                        .idempotencyKey(idempotencyKey)
                        .build());
                    log.info("Enqueued LISTING_DELIST for {} listing {} — Shopify product went {}",
                        listing.getMarketplaceType(), listing.getId(), shopifyStatus);
                }
            }
            return; // No further processing for inactive products
        }

        // ── Active product — apply field changes and propagate to live listings ─
        applyProductFields(product, payload);
        applyMetafields(product, shopDomain, shopifyProductId);

        boolean wasArchived = product.getStatus() == ProductStatus.ARCHIVED;
        if (wasArchived) {
            product.setStatus(ProductStatus.ACTIVE);
            log.info("Restored product {} to ACTIVE — Shopify status is now 'active'", product.getSku());
        }

        productRepository.save(product);

        if (wasArchived) {
            // Product was just restored. Any previous marketplace listings were deisted
            // and are no longer ACTIVE, so there's nothing to send LISTING_UPDATE to.

            // Respect excluded tags on restoration — if the product has been tagged to
            // stay off marketplaces, don't re-queue it even after it's re-activated.
            if (isExcludedByTags(payload, shopDomain)) {
                log.info("Restored product {} not queued for marketplace listing — matches an excluded tag",
                    product.getSku());
                return;
            }

            // For each connected non-Shopify marketplace:
            //   - If a listing record exists and is in a terminal state (INACTIVE, DELISTED,
            //     FAILED, SOLD) → reset it to NEEDS_REVIEW so the user can re-publish.
            //   - If a listing record exists and is already live/pending (ACTIVE, NEEDS_REVIEW,
            //     PENDING, PUBLISHING) → leave it alone.
            //   - If no listing record exists at all → create a fresh NEEDS_REVIEW one.
            final Product restoredProduct = product;
            List<MarketplaceAccount> accounts = accountRepository.findByActiveTrue().stream()
                .filter(a -> a.getMarketplaceType() != MarketplaceType.SHOPIFY)
                .toList();

            for (MarketplaceAccount account : accounts) {
                java.util.Optional<MarketplaceListing> existing =
                    listingRepository.findByProductIdAndMarketplaceAccountId(
                        restoredProduct.getId(), account.getId());

                if (existing.isPresent()) {
                    MarketplaceListing listing = existing.get();
                    ListingStatus status = listing.getListingStatus();
                    boolean alreadyLive = status == ListingStatus.ACTIVE
                        || status == ListingStatus.NEEDS_REVIEW
                        || status == ListingStatus.PENDING
                        || status == ListingStatus.PUBLISHING;
                    if (!alreadyLive) {
                        listing.setListingStatus(ListingStatus.NEEDS_REVIEW);
                        listing.setExternalListingId(null); // stale ID from old listing
                        listingRepository.save(listing);
                        log.info("Reset listing {} to NEEDS_REVIEW for restored product {} on {}",
                            listing.getId(), restoredProduct.getSku(), account.getMarketplaceType());
                    }
                } else {
                    MarketplaceListing listing = MarketplaceListing.builder()
                        .productId(restoredProduct.getId())
                        .marketplaceAccountId(account.getId())
                        .marketplaceType(account.getMarketplaceType())
                        .listingStatus(ListingStatus.NEEDS_REVIEW)
                        .build();
                    listingRepository.save(listing);
                    log.info("Created NEEDS_REVIEW listing for restored product {} on {} account {}",
                        restoredProduct.getSku(), account.getMarketplaceType(), account.getId());
                }
            }
            return;
        }

        // For ACTIVE listings (already published to a marketplace), immediately enqueue a
        // LISTING_UPDATE job so the change cascades automatically — no human review required.
        // Shopify is the source of truth; price or title changes there should propagate
        // to every live marketplace listing without friction.
        //
        // NEEDS_REVIEW / PENDING / FAILED listings are left alone — they haven't been
        // published yet and will pick up the current product data when they are published.
        List<MarketplaceListing> activeListings =
            listingRepository.findByProductIdAndListingStatus(product.getId(), ListingStatus.ACTIVE);

        for (MarketplaceListing listing : activeListings) {
            if (listing.getMarketplaceType() == MarketplaceType.SHOPIFY) continue;

            String idempotencyKey = "shopify-product-update-" + shopifyProductId
                + "-listing-" + listing.getId()
                + "-" + payload.path("updated_at").asText(String.valueOf(System.currentTimeMillis()));

            if (syncJobRepository.existsByIdempotencyKey(idempotencyKey)) {
                log.debug("Skipping duplicate LISTING_UPDATE for listing {}", listing.getId());
                continue;
            }

            SyncJob job = SyncJob.builder()
                .jobType(SyncJobType.LISTING_UPDATE)
                .marketplaceType(listing.getMarketplaceType())
                .marketplaceAccountId(listing.getMarketplaceAccountId())
                .productId(product.getId())
                .listingId(listing.getId())
                .payload(Map.of("shopifyProductId", shopifyProductId))
                .idempotencyKey(idempotencyKey)
                .build();

            syncJobProducer.enqueue(job);
            log.info("Enqueued LISTING_UPDATE for {} listing {} after Shopify product update",
                listing.getMarketplaceType(), listing.getId());
        }
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

    // ── fulfillments/create — forward tracking to origin marketplace ─────────

    @Transactional
    protected void processFulfillmentCreate(String shopDomain, byte[] rawBody) throws Exception {
        JsonNode payload = objectMapper.readTree(rawBody);

        // Shopify sends the Shopify order ID as "order_id" on the fulfillment object
        String shopifyOrderId = payload.path("order_id").asText(null);
        String trackingNumber = payload.path("tracking_number").asText(null);
        String trackingCarrier = payload.path("tracking_company").asText(null);

        // Prefer the first URL from tracking_urls array if available; fall back to tracking_url
        String trackingUrl = null;
        JsonNode urlsNode = payload.path("tracking_urls");
        if (urlsNode.isArray() && urlsNode.size() > 0) {
            trackingUrl = urlsNode.get(0).asText(null);
        }
        if (trackingUrl == null || trackingUrl.isBlank()) {
            trackingUrl = payload.path("tracking_url").asText(null);
        }

        log.info("Shopify fulfillments/create: orderId={} carrier={} tracking={} shop={}",
            shopifyOrderId, trackingCarrier, trackingNumber, shopDomain);

        // Delegate to the notification service which handles marketplace routing
        fulfillmentNotificationService.notifyMarketplace(
            shopifyOrderId, trackingNumber, trackingCarrier, trackingUrl);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /**
     * Fetches metafields from Shopify for the given product and applies any
     * known values to the Product entity.
     *
     * Currently handled metafields:
     *   namespace=custom, key=youtube_url → product.videoUrl
     *
     * This is a best-effort call — any API or parse error is logged and ignored
     * so that a missing metafield never blocks product processing.
     */
    private void applyMetafields(Product product, String shopDomain, String shopifyProductId) {
        // Locate the Shopify account by shop domain so we can authenticate the metafields API call.
        // externalAccountId is set to the shop domain during OAuth (same value as externalShopUrl).
        accountRepository.findByExternalAccountId(shopDomain).ifPresentOrElse(account -> {
            try {
                List<JsonNode> metafields =
                    shopifyApiClient.fetchProductMetafields(account, shopifyProductId);

                for (JsonNode mf : metafields) {
                    String ns  = mf.path("namespace").asText("");
                    String key = mf.path("key").asText("");
                    String val = mf.path("value").asText("");

                    if (!"custom".equals(ns) || val.isBlank()) continue;

                    switch (key) {
                        case "youtube_url"      -> product.setVideoUrl(val);
                        case "reverb_model"     -> product.setModel(val);
                        case "reverb_year"      -> product.setYearMade(val);
                        case "reverb_finish"    -> product.setFinish(val);
                        case "condition_notes"  -> product.setConditionNotes(val);
                        case "condition"        -> {
                            ProductCondition parsed = parseCondition(val);
                            if (parsed != null) {
                                product.setCondition(parsed);
                            } else {
                                log.warn("Unrecognised condition value '{}' on product {} — keeping existing",
                                    val, shopifyProductId);
                            }
                        }
                        default -> log.debug("Unhandled Shopify metafield custom.{} on product {}",
                            key, shopifyProductId);
                    }
                }
                log.debug("Applied metafields to product {} from Shopify", shopifyProductId);
            } catch (Exception e) {
                log.warn("Could not apply metafields for product {}: {}", shopifyProductId, e.getMessage());
            }
        }, () -> log.debug("No Shopify account found for shop domain {} — skipping metafields", shopDomain));
    }

    /**
     * Returns true if the product payload contains any Shopify tag that appears
     * in the Shopify account's {@code syncSettings["excluded_tags"]} list.
     *
     * When true, the product is still imported/updated in Gearline but NEEDS_REVIEW
     * marketplace listings are NOT created — the item is intentionally kept off
     * all external marketplaces (e.g. in-store-only or consignment inventory).
     *
     * Tag matching is case-insensitive and trims surrounding whitespace.
     */
    private boolean isExcludedByTags(JsonNode payload, String shopDomain) {
        String tagsStr = payload.path("tags").asText("");
        if (tagsStr.isBlank()) return false;

        Set<String> productTags = Arrays.stream(tagsStr.split(","))
            .map(String::strip)
            .map(String::toLowerCase)
            .filter(t -> !t.isBlank())
            .collect(Collectors.toSet());

        return accountRepository.findByExternalAccountId(shopDomain)
            .map(account -> {
                Object raw = account.getSyncSettings() != null
                    ? account.getSyncSettings().get("excluded_tags") : null;
                if (raw instanceof List<?> excluded) {
                    return excluded.stream()
                        .map(t -> t.toString().toLowerCase().strip())
                        .anyMatch(productTags::contains);
                }
                return false;
            })
            .orElse(false);
    }

    /**
     * Parses a condition string from a Shopify metafield into a {@link ProductCondition}.
     *
     * Accepts both our enum names (case-insensitive, spaces/hyphens treated as underscores)
     * and Reverb condition slugs, so sellers can use whichever is more natural in Shopify:
     *
     *   "Brand New" / "new" / "brand-new"     → NEW
     *   "Mint"                                 → MINT
     *   "Excellent"                            → EXCELLENT
     *   "Very Good" / "very-good"              → VERY_GOOD
     *   "Good"                                 → GOOD
     *   "Fair"                                 → FAIR
     *   "Poor"                                 → POOR
     *   "Open Box" / "B-Stock" / "b-stock"    → OPEN_BOX
     *   "Used"                                 → USED
     *   "For Parts" / "non-functioning"        → FOR_PARTS
     */
    private ProductCondition parseCondition(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String normalised = raw.strip().toUpperCase()
            .replace("-", "_")
            .replace(" ", "_");

        // Direct enum name match
        try { return ProductCondition.valueOf(normalised); } catch (IllegalArgumentException ignored) {}

        // Reverb slug aliases and common variations
        return switch (normalised) {
            case "BRAND_NEW"        -> ProductCondition.NEW;
            case "VERY_GOOD_PLUS"   -> ProductCondition.VERY_GOOD;
            case "B_STOCK"          -> ProductCondition.OPEN_BOX;
            case "NON_FUNCTIONING"  -> ProductCondition.FOR_PARTS;
            default                 -> null;
        };
    }

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
     *
     * All fields that can change in Shopify are kept in sync here, including SKU.
     * Shopify's own IDs (shopifyProductId, shopifyVariantId, shopifyInventoryItemId)
     * are never overwritten — they are identity keys set at creation.
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
        // product_type → category (informational; used for marketplace listing categorisation)
        if (payload.has("product_type") && !payload.path("product_type").asText().isBlank()) {
            product.setCategory(payload.path("product_type").asText());
        }

        // Variant fields — price, quantity, and importantly SKU
        JsonNode variant = payload.path("variants").path(0);
        if (!variant.isMissingNode()) {
            // SKU: update whenever Shopify has a non-blank value.
            // If the product was imported before a SKU was set (stored as "SHOPIFY-{id}"),
            // this will replace the placeholder with the real SKU once the merchant adds one.
            String newSku = variant.path("sku").asText();
            if (!newSku.isBlank()) {
                product.setSku(newSku);
            }

            String priceStr = variant.path("price").asText();
            if (!priceStr.isBlank()) {
                try { product.setPrice(new BigDecimal(priceStr)); } catch (NumberFormatException ignored) {}
            }
            int qty = variant.path("inventory_quantity").asInt(Integer.MIN_VALUE);
            if (qty != Integer.MIN_VALUE) {
                product.setQuantity(Math.max(0, qty));
            }

            // Keep variant/inventory IDs current in case Shopify ever reassigns them
            String variantId = variant.path("id").asText();
            if (!variantId.isBlank() && !variantId.equals("null")) {
                product.setShopifyVariantId(variantId);
            }
            String inventoryItemId = variant.path("inventory_item_id").asText();
            if (!inventoryItemId.isBlank() && !inventoryItemId.equals("null")) {
                product.setShopifyInventoryItemId(inventoryItemId);
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
