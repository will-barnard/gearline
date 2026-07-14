package com.gearline.marketplace.shopify;

import com.fasterxml.jackson.databind.JsonNode;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Dimensions;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.shopify.client.ShopifyProductsPage;
import com.gearline.marketplace.shopify.client.ShopifyApiClient;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Pull-based re-sync of a single product's fields from the Shopify Admin API.
 *
 * The normal update path relies on Shopify webhooks (push). When a webhook
 * fails silently (transient network error, DB constraint violation swallowed
 * by the catch-all handler in ShopifyWebhookProcessor) the Gearline product
 * record drifts from Shopify. This service corrects drift on-demand without
 * touching marketplace listings.
 *
 * Key difference from the initial-sync path:
 *   - Does NOT create or reset MarketplaceListing rows.
 *   - Checks for SKU collisions before writing and returns a clear error
 *     instead of silently failing.
 *   - Returns a structured result so the caller can show the user exactly
 *     what changed (especially the old → new SKU diff).
 */
@Service
@RequiredArgsConstructor
@Transactional
@Slf4j
public class ShopifyResyncService {

    private final ProductRepository productRepository;
    private final MarketplaceAccountRepository accountRepository;
    private final ShopifyApiClient shopifyApiClient;

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Re-syncs all mutable product fields (title, brand, SKU, price, qty, images,
     * metafields, etc.) from Shopify for the given Gearline product ID.
     *
     * @param productId Gearline product UUID
     * @return a structured result describing what changed (or why it failed)
     */
    public ResyncResult resync(UUID productId) {

        // ── Preconditions ──────────────────────────────────────────────────────
        Optional<Product> maybeProduct = productRepository.findById(productId);
        if (maybeProduct.isEmpty()) {
            return ResyncResult.fail("Product not found: " + productId);
        }
        Product product = maybeProduct.get();

        if (product.getShopifyProductId() == null || product.getShopifyProductId().isBlank()) {
            return ResyncResult.fail(
                "This product was not imported from Shopify (no Shopify product ID) — " +
                "update the SKU manually in the SKU Audit table.");
        }

        // ── Find the connected Shopify account ─────────────────────────────────
        Optional<MarketplaceAccount> maybeAccount = accountRepository
            .findByMarketplaceTypeAndActiveTrue(MarketplaceType.SHOPIFY)
            .stream().findFirst();

        if (maybeAccount.isEmpty()) {
            return ResyncResult.fail("No active Shopify account is connected to Gearline.");
        }
        MarketplaceAccount account = maybeAccount.get();

        // ── Fetch current product state from Shopify ───────────────────────────
        JsonNode shopifyProduct;
        try {
            shopifyProduct = shopifyApiClient.fetchProduct(account, product.getShopifyProductId());
        } catch (Exception e) {
            return ResyncResult.fail(
                "Shopify API error: " + e.getMessage() +
                ". The product may have been deleted from Shopify.");
        }

        if (shopifyProduct.isMissingNode() || shopifyProduct.isNull()) {
            return ResyncResult.fail(
                "Shopify returned an empty response for product ID " +
                product.getShopifyProductId() + " — it may have been deleted.");
        }

        // ── Pre-flight: check SKU collision before applying any changes ─────────
        //
        // A collision is the most common reason webhook-based SKU updates fail
        // silently. Surface it as a clear, actionable error instead of a DB
        // exception swallowed by a catch-all.
        String oldSku = product.getSku();
        String shopifySku = shopifyProduct.path("variants").path(0).path("sku").asText();

        if (!shopifySku.isBlank() && !shopifySku.equals(oldSku)) {
            // Check whether a DIFFERENT product already holds the Shopify SKU.
            // This is the most common cause of silent webhook failures (unique constraint violation).
            Optional<Product> collider = productRepository.findBySku(shopifySku)
                .filter(p -> !p.getId().equals(productId));
            if (collider.isPresent()) {
                Product other = collider.get();
                return ResyncResult.conflict(
                    shopifySku,
                    "Shopify has SKU \"" + shopifySku + "\" for \"" + product.getTitle() + "\", " +
                    "but that SKU is already held by \"" + other.getTitle() + "\" in Gearline. " +
                    "Use \"Resync all SKUs from Shopify\" to fix all swapped SKUs at once.",
                    other.getId().toString(),
                    other.getTitle());
            }
        }

        // ── Apply field updates ────────────────────────────────────────────────
        applyFields(product, shopifyProduct);

        // Apply metafields (best-effort — failures are logged, not thrown)
        String shopDomain = account.getExternalShopUrl();
        try {
            List<JsonNode> metafields =
                shopifyApiClient.fetchProductMetafields(account, product.getShopifyProductId());
            applyMetafields(product, metafields);
        } catch (Exception e) {
            log.warn("Could not apply metafields during re-sync for Shopify product {}: {}",
                product.getShopifyProductId(), e.getMessage());
        }

        productRepository.save(product);

        String newSku = product.getSku();
        log.info("Re-synced product {} ('{}') from Shopify — SKU: {} → {}",
            productId, product.getTitle(), oldSku, newSku);

        return ResyncResult.ok(shopifySku, oldSku, newSku);
    }

    // ── Bulk SKU resync ────────────────────────────────────────────────────────

    /**
     * Fetches all active products from Shopify and reconciles SKUs in Gearline.
     *
     * Handles the "swapped SKU" problem that individual per-product resync cannot:
     * when products A and B have each other's SKUs, both individual resyncs fail
     * with a collision. This method resolves it atomically by:
     *   1. Setting every product that needs a SKU change to a unique temp SKU
     *      (format: "RESYNC-TEMP-{uuid}"), clearing all collisions.
     *   2. Setting every product to its correct Shopify SKU.
     *
     * Runs in a single transaction so the temp-SKU state is never visible
     * to other readers.
     *
     * @return a summary: total products compared, SKUs changed, errors encountered
     */
    @Transactional
    public BulkResyncResult bulkResyncSkus() {
        // Find the active Shopify account
        Optional<MarketplaceAccount> maybeAccount = accountRepository
            .findByMarketplaceTypeAndActiveTrue(MarketplaceType.SHOPIFY)
            .stream().findFirst();
        if (maybeAccount.isEmpty()) {
            return new BulkResyncResult(false, "No active Shopify account is connected.", 0, 0, 0, List.of());
        }
        MarketplaceAccount account = maybeAccount.get();

        // ── Step 1: Build shopifyProductId → correctSku map from Shopify ────────
        Map<String, String> shopifySkuMap = new HashMap<>();
        try {
            String pageInfo = null;
            do {
                ShopifyProductsPage page = shopifyApiClient.fetchProducts(account, pageInfo);
                for (JsonNode p : page.products()) {
                    String shopifyId = p.path("id").asText();
                    String sku = p.path("variants").path(0).path("sku").asText();
                    if (!shopifyId.isBlank() && !sku.isBlank()) {
                        shopifySkuMap.put(shopifyId, sku);
                    }
                }
                pageInfo = page.nextPageInfo();
            } while (pageInfo != null);
        } catch (Exception e) {
            log.error("Bulk SKU resync: failed to fetch products from Shopify", e);
            return new BulkResyncResult(false, "Shopify API error: " + e.getMessage(), 0, 0, 0, List.of());
        }

        log.info("Bulk SKU resync: fetched {} products from Shopify", shopifySkuMap.size());

        // ── Step 2: Find Gearline products that need a SKU update ───────────────
        List<Product> allProducts = productRepository.findAll();
        record PendingUpdate(Product product, String correctSku, String oldSku) {}
        List<PendingUpdate> pending = new ArrayList<>();

        for (Product product : allProducts) {
            if (product.getShopifyProductId() == null || product.getShopifyProductId().isBlank()) continue;
            String correctSku = shopifySkuMap.get(product.getShopifyProductId());
            if (correctSku == null) continue; // not in active Shopify products list
            if (!correctSku.equals(product.getSku())) {
                pending.add(new PendingUpdate(product, correctSku, product.getSku()));
            }
        }

        if (pending.isEmpty()) {
            return new BulkResyncResult(true, "All SKUs already match Shopify — nothing to update.",
                allProducts.size(), 0, 0, List.of());
        }

        log.info("Bulk SKU resync: {} products need SKU corrections", pending.size());

        // ── Step 3: Find "blockers" ──────────────────────────────────────────────
        // A blocker is a product NOT in the pending list that currently holds a SKU
        // that some pending product needs. This happens when a product is archived or
        // draft in Shopify (so it wasn't in the active fetch) but still holds a SKU
        // in Gearline. If we don't temp-ify it first, the final flush will hit a
        // duplicate-key violation even though all the pending products are correct.
        Set<String> targetSkus = new HashSet<>();
        Set<UUID>   pendingIds = new HashSet<>();
        for (PendingUpdate u : pending) {
            targetSkus.add(u.correctSku());
            pendingIds.add(u.product().getId());
        }
        List<Product> blockers = allProducts.stream()
            .filter(p -> targetSkus.contains(p.getSku()) && !pendingIds.contains(p.getId()))
            .toList();

        if (!blockers.isEmpty()) {
            log.warn("Bulk SKU resync: {} product(s) are blocking target SKUs — they will be moved to " +
                     "temp SKUs and will need manual SKU correction afterwards", blockers.size());
        }

        // ── Step 4: Break all collisions by setting temp SKUs first ─────────────
        // This covers both swapped-SKU cycles among pending products AND blockers.
        for (PendingUpdate u : pending) {
            u.product().setSku("RESYNC-TEMP-" + UUID.randomUUID());
            productRepository.save(u.product());
        }
        for (Product blocker : blockers) {
            log.warn("Bulk SKU resync: blocker '{}' (SKU '{}') set to temp SKU",
                blocker.getTitle(), blocker.getSku());
            blocker.setSku("RESYNC-TEMP-" + UUID.randomUUID());
            productRepository.save(blocker);
        }
        // Flush so all temp SKUs are written before we apply the correct ones
        productRepository.flush();

        // ── Step 5: Apply the correct Shopify SKUs ───────────────────────────────
        List<String> errors = new ArrayList<>();
        int changed = 0;
        for (PendingUpdate u : pending) {
            try {
                u.product().setSku(u.correctSku());
                productRepository.save(u.product());
                log.info("Bulk SKU resync: '{}' SKU {} → {}", u.product().getTitle(), u.oldSku(), u.correctSku());
                changed++;
            } catch (Exception e) {
                log.error("Bulk SKU resync: failed to set SKU '{}' for product {}: {}",
                    u.correctSku(), u.product().getId(), e.getMessage());
                errors.add("\"" + u.product().getTitle() + "\": " + e.getMessage());
                // Leave the product on its temp SKU — admin can fix manually
            }
        }

        productRepository.flush();

        // Report any blocker products that were moved to temp SKUs and need manual attention
        for (Product blocker : blockers) {
            errors.add("\"" + blocker.getTitle() + "\" was moved to a temp SKU because it held a SKU " +
                       "needed by an active Shopify product. Please set its SKU manually in the SKU Audit page.");
        }

        String summary = changed + " SKU" + (changed != 1 ? "s" : "") + " updated from Shopify";
        if (!errors.isEmpty()) summary += "; " + errors.size() + " error(s)";

        return new BulkResyncResult(errors.isEmpty(), summary,
            allProducts.size(), pending.size(), changed, errors);
    }

    public record BulkResyncResult(
        boolean success,
        String message,
        int totalCompared,
        int needsUpdate,
        int updated,
        List<String> errors
    ) {}

    // ── Field application (mirrors ShopifyWebhookProcessor.applyProductFields) ─

    private void applyFields(Product product, JsonNode p) {
        String title = p.path("title").asText();
        if (!title.isBlank()) {
            product.setTitle(title);
        }
        if (p.has("body_html")) {
            product.setDescription(p.path("body_html").asText());
        }
        String vendor = p.path("vendor").asText();
        if (!vendor.isBlank()) {
            product.setBrand(vendor);
        }
        String productType = p.path("product_type").asText();
        if (!productType.isBlank()) {
            product.setCategory(productType);
        }

        JsonNode variant = p.path("variants").path(0);
        if (!variant.isMissingNode()) {
            String sku = variant.path("sku").asText();
            if (!sku.isBlank()) {
                product.setSku(sku);
            }
            String priceStr = variant.path("price").asText();
            if (!priceStr.isBlank()) {
                try { product.setPrice(new BigDecimal(priceStr)); } catch (NumberFormatException ignored) {}
            }
            int qty = variant.path("inventory_quantity").asInt(Integer.MIN_VALUE);
            if (qty != Integer.MIN_VALUE) {
                product.setQuantity(Math.max(0, qty));
            }
            if (!variant.path("grams").isMissingNode() && !variant.path("grams").isNull()) {
                int grams = variant.path("grams").asInt(0);
                if (grams > 0) {
                    product.setWeightKg(new BigDecimal(grams)
                        .divide(new BigDecimal("1000"), 3, RoundingMode.HALF_UP));
                }
            }
            String variantId = variant.path("id").asText();
            if (!variantId.isBlank() && !variantId.equals("null")) {
                product.setShopifyVariantId(variantId);
            }
            String inventoryItemId = variant.path("inventory_item_id").asText();
            if (!inventoryItemId.isBlank() && !inventoryItemId.equals("null")) {
                product.setShopifyInventoryItemId(inventoryItemId);
            }
        }

        JsonNode images = p.path("images");
        if (images.isArray() && !images.isEmpty()) {
            List<String> urls = new ArrayList<>();
            images.forEach(img -> {
                String src = img.path("src").asText();
                if (!src.isBlank()) urls.add(src);
            });
            if (!urls.isEmpty()) {
                product.setImageUrls(urls);
            }
        }
    }

    private void applyMetafields(Product product, List<JsonNode> metafields) {
        for (JsonNode mf : metafields) {
            String ns  = mf.path("namespace").asText("");
            String key = mf.path("key").asText("");
            String val = mf.path("value").asText("");
            if (!"custom".equals(ns) || val.isBlank()) continue;

            switch (key) {
                case "youtube_url"     -> product.setVideoUrl(val);
                case "reverb_model"    -> product.setModel(val);
                case "reverb_year"     -> product.setYearMade(val);
                case "reverb_finish"   -> product.setFinish(val);
                case "condition_notes" -> product.setConditionNotes(val);
                case "dim_length_in", "dim_width_in", "dim_height_in" -> {
                    try {
                        BigDecimal inches = new BigDecimal(val.strip());
                        if (product.getDimensions() == null) {
                            product.setDimensions(new Dimensions());
                        }
                        switch (key) {
                            case "dim_length_in" -> product.getDimensions().setLengthIn(inches);
                            case "dim_width_in"  -> product.getDimensions().setWidthIn(inches);
                            case "dim_height_in" -> product.getDimensions().setHeightIn(inches);
                        }
                    } catch (NumberFormatException e) {
                        log.warn("Invalid dimension value for custom.{} on product {}: '{}'",
                            key, product.getShopifyProductId(), val);
                    }
                }
                case "condition" -> {
                    ProductCondition parsed = parseCondition(val);
                    if (parsed != null) product.setCondition(parsed);
                }
                default -> { /* other metafields ignored */ }
            }
        }
    }

    private ProductCondition parseCondition(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String normalised = raw.strip().toUpperCase().replace("-", "_").replace(" ", "_");
        try { return ProductCondition.valueOf(normalised); } catch (IllegalArgumentException ignored) {}
        return switch (normalised) {
            case "BRAND_NEW"       -> ProductCondition.NEW;
            case "VERY_GOOD_PLUS"  -> ProductCondition.VERY_GOOD;
            case "B_STOCK"         -> ProductCondition.OPEN_BOX;
            case "NON_FUNCTIONING" -> ProductCondition.FOR_PARTS;
            default                -> null;
        };
    }

    // ── Result type ────────────────────────────────────────────────────────────

    public record ResyncResult(
        boolean success,
        boolean isConflict,
        String message,
        /** The SKU Shopify currently has for this product. */
        String shopifySku,
        /** The SKU Gearline had before the resync. */
        String oldSku,
        /** The SKU Gearline now has after the resync (same as shopifySku on success). */
        String newSku,
        /** When isConflict=true: the Gearline product ID that holds shopifySku. */
        String conflictProductId,
        /** When isConflict=true: the title of the conflicting product. */
        String conflictProductTitle
    ) {
        public boolean skuChanged() {
            return success && !Objects.equals(oldSku, newSku);
        }

        static ResyncResult ok(String shopifySku, String oldSku, String newSku) {
            boolean changed = !Objects.equals(oldSku, newSku);
            return new ResyncResult(
                true, false,
                changed
                    ? "SKU updated: \"" + oldSku + "\" → \"" + newSku + "\""
                    : "Already in sync — no SKU change needed",
                shopifySku, oldSku, newSku, null, null);
        }

        static ResyncResult fail(String message) {
            return new ResyncResult(false, false, message, null, null, null, null, null);
        }

        static ResyncResult conflict(String shopifySku, String message,
                                     String conflictProductId, String conflictProductTitle) {
            return new ResyncResult(false, true, message, shopifySku, null, null,
                conflictProductId, conflictProductTitle);
        }
    }
}
