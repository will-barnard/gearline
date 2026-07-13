package com.gearline.marketplace.shopify;

import com.fasterxml.jackson.databind.JsonNode;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Dimensions;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.shopify.client.ShopifyApiClient;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
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
            if (productRepository.existsBySku(shopifySku)) {
                // Find which product owns it so the user knows where the conflict is
                String conflictId = productRepository.findBySku(shopifySku)
                    .map(p -> "product " + p.getTitle() + " (ID " + p.getId() + ")")
                    .orElse("another product");
                return ResyncResult.conflict(
                    "Shopify has SKU \"" + shopifySku + "\" for this product, but that SKU is already " +
                    "assigned to " + conflictId + " in Gearline. " +
                    "Fix the duplicate manually first (e.g. edit the wrong product's SKU inline), " +
                    "then re-sync again.");
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

        return ResyncResult.ok(oldSku, newSku);
    }

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
        String oldSku,
        String newSku
    ) {
        public boolean skuChanged() {
            return success && !Objects.equals(oldSku, newSku);
        }

        static ResyncResult ok(String oldSku, String newSku) {
            boolean changed = !Objects.equals(oldSku, newSku);
            return new ResyncResult(true, false, oldSku, newSku,
                changed
                    ? "SKU updated: \"" + oldSku + "\" → \"" + newSku + "\""
                    : "Fields refreshed — SKU unchanged");
        }

        static ResyncResult fail(String message) {
            return new ResyncResult(false, false, message, null, null);
        }

        static ResyncResult conflict(String message) {
            return new ResyncResult(false, true, message, null, null);
        }
    }
}
