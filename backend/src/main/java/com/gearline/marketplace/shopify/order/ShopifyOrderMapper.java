package com.gearline.marketplace.shopify.order;

import com.gearline.domain.order.BuyerInfo;
import com.gearline.domain.order.OrderLineItem;
import com.gearline.domain.order.ShippingAddress;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.common.dto.ImportedOrder;
import com.gearline.infrastructure.persistence.ProductRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds a Shopify Admin API order creation request body from an {@link ImportedOrder}.
 *
 * ── Key design choices ───────────────────────────────────────────────────────
 *
 * inventory_behaviour = "bypass"
 *   CRITICAL. Without this, Shopify would deduct inventory when the order is
 *   created here, double-counting what our cross-channel sync already handled.
 *
 * financial_status = "paid"
 *   The buyer already paid on Reverb or eBay. We create the order as paid so
 *   it doesn't appear as an outstanding payment in Shopify.
 *
 * send_receipt = false / send_fulfillment_receipt = false
 *   The marketplace already sent the buyer a confirmation. We don't want
 *   Shopify to send a duplicate email.
 *
 * source_name = "reverb" | "ebay"
 *   Identifies the origin channel in Shopify's order analytics.
 *
 * tags = "reverb" | "ebay"
 *   Makes it easy to filter imported orders in the Shopify admin.
 *
 * variant_id
 *   If the Product has a shopifyVariantId we use it so the order line item is
 *   properly linked to the Shopify product. If not, we send title + sku as
 *   a custom line item — Shopify accepts this without a variant reference.
 *
 * Docs: https://shopify.dev/docs/api/admin-rest/2024-10/resources/order#post-orders
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ShopifyOrderMapper {

    private final ProductRepository productRepository;

    /**
     * Builds the full order body to POST to Shopify.
     *
     * @param importedOrder the normalised order from Reverb or eBay
     * @param sourceType    REVERB or EBAY (used for tags/source_name)
     * @return the JSON body map ready for {@code ShopifyApiClient.createOrder()}
     */
    public Map<String, Object> toShopifyOrderBody(ImportedOrder importedOrder, MarketplaceType sourceType) {
        String source = sourceType.name().toLowerCase(); // "reverb" or "ebay"

        Map<String, Object> order = new HashMap<>();

        // ── Line items ────────────────────────────────────────────────────────
        order.put("line_items", buildLineItems(importedOrder.getLineItems(), source));

        // ── Financial ─────────────────────────────────────────────────────────
        order.put("financial_status", "paid");
        order.put("currency", importedOrder.getCurrency() != null ? importedOrder.getCurrency() : "USD");

        if (importedOrder.getShippingTotal() != null
                && importedOrder.getShippingTotal().signum() > 0) {
            order.put("shipping_lines", List.of(Map.of(
                "title", "Shipping (" + source + ")",
                "price", importedOrder.getShippingTotal().toPlainString(),
                "code",  source + "_shipping"
            )));
        }

        // ── Customer ──────────────────────────────────────────────────────────
        BuyerInfo buyer = importedOrder.getBuyerInfo();
        if (buyer != null) {
            Map<String, Object> customer = new HashMap<>();
            if (buyer.getFirstName() != null) customer.put("first_name", buyer.getFirstName());
            if (buyer.getLastName()  != null) customer.put("last_name",  buyer.getLastName());
            if (buyer.getEmail()     != null) customer.put("email",      buyer.getEmail());
            if (!customer.isEmpty()) order.put("customer", customer);
        }

        // ── Shipping address ──────────────────────────────────────────────────
        ShippingAddress addr = importedOrder.getShippingAddress();
        if (addr != null) {
            Map<String, Object> shipAddr = new HashMap<>();
            if (buyer != null) {
                shipAddr.put("first_name", nvl(buyer.getFirstName(), ""));
                shipAddr.put("last_name",  nvl(buyer.getLastName(),  ""));
            }
            if (addr.getLine1()      != null) shipAddr.put("address1",  addr.getLine1());
            if (addr.getLine2()      != null) shipAddr.put("address2",  addr.getLine2());
            if (addr.getCity()       != null) shipAddr.put("city",      addr.getCity());
            if (addr.getState()      != null) shipAddr.put("province",  addr.getState());
            if (addr.getPostalCode() != null) shipAddr.put("zip",       addr.getPostalCode());
            if (addr.getCountry()    != null) shipAddr.put("country",   addr.getCountry());
            if (!shipAddr.isEmpty()) order.put("shipping_address", shipAddr);
        }

        // ── Order number override ─────────────────────────────────────────────
        // Set `name` so the order shows as "#26040673" (the marketplace order
        // number) instead of Shopify's auto-incremented "#1001", "#1002", etc.
        // Shopify accepts a custom `name` on creation via the Admin API.
        // Reverb IDs are in the millions, eBay IDs are long numeric strings —
        // neither collides with normal Shopify store order numbers.
        order.put("name", "#" + importedOrder.getExternalOrderId());

        // ── Source / channel metadata ─────────────────────────────────────────
        // source_name    → "Channel" label in Shopify's "Channel Information" panel
        // source_identifier → "Order ID" in the same panel
        // source_url     → makes the Order ID a clickable link back to the marketplace
        String sourceName = sourceType.name().charAt(0)
            + sourceType.name().substring(1).toLowerCase(); // "Reverb" / "Ebay" → "Reverb" / "eBay"
        // Normalise eBay capitalisation
        if (sourceType.name().equalsIgnoreCase("EBAY")) sourceName = "eBay";

        order.put("source_name",       source);          // used for analytics grouping
        order.put("source_identifier", importedOrder.getExternalOrderId());
        if (importedOrder.getMarketplaceOrderUrl() != null) {
            order.put("source_url", importedOrder.getMarketplaceOrderUrl());
        }

        order.put("tags", source);
        order.put("note", "Imported from " + sourceName + " order #" + importedOrder.getExternalOrderId());

        // ── Note attributes ("Additional details" panel in Shopify admin) ─────
        // These populate the key/value pairs shown under "Additional details"
        // on the order detail page.
        List<Map<String, String>> noteAttributes = new ArrayList<>();
        noteAttributes.add(Map.of("name", "Channel",      "value", sourceName));
        noteAttributes.add(Map.of("name", "Order Number", "value", importedOrder.getExternalOrderId()));
        if (buyer != null && buyer.getUsername() != null && !buyer.getUsername().isBlank()) {
            noteAttributes.add(Map.of("name", "Buyer Username", "value", buyer.getUsername()));
        }
        if (importedOrder.getMarketplaceOrderUrl() != null) {
            noteAttributes.add(Map.of("name", sourceName + " Order URL", "value", importedOrder.getMarketplaceOrderUrl()));
        }
        order.put("note_attributes", noteAttributes);

        // ── Behaviour flags ───────────────────────────────────────────────────
        // inventory_behaviour=bypass: don't adjust Shopify stock — we handle cross-channel sync
        order.put("inventory_behaviour",        "bypass");
        order.put("send_receipt",               false);
        order.put("send_fulfillment_receipt",   false);

        return Map.of("order", order);
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private List<Map<String, Object>> buildLineItems(List<OrderLineItem> lineItems, String source) {
        List<Map<String, Object>> result = new ArrayList<>();

        for (OrderLineItem item : lineItems) {
            Map<String, Object> li = new HashMap<>();

            // If we have a Shopify variant ID stored on the product, use it
            // so the line item links back to the Shopify product catalogue.
            String variantId = resolveShopifyVariantId(item.getSku());
            if (variantId != null && !variantId.isBlank()) {
                try {
                    li.put("variant_id", Long.parseLong(variantId));
                } catch (NumberFormatException e) {
                    log.warn("Non-numeric Shopify variant ID '{}' for SKU '{}' — using title/SKU fallback",
                        variantId, item.getSku());
                }
            }

            // Always include title and SKU — Shopify shows these in the order even with variant_id
            if (item.getTitle() != null) li.put("title", item.getTitle());
            if (item.getSku()   != null) li.put("sku",   item.getSku());
            li.put("quantity", item.getQuantity() != null ? item.getQuantity() : 1);
            if (item.getUnitPrice() != null) {
                li.put("price", item.getUnitPrice().toPlainString());
            }
            li.put("requires_shipping", true);

            result.add(li);
        }

        // Finding #30: do NOT add a $0 placeholder when there are no line items.
        // A $0 placeholder creates a fake line item with no SKU, no variant link, and
        // zero revenue — this corrupts Shopify's analytics, inventory, and reporting.
        // The caller (ShopifyOrderPushService) is responsible for skipping the push
        // entirely when line items are empty, so returning an empty list here is safe.
        if (result.isEmpty()) {
            log.warn("Order has no mappable line items for {} — Shopify push will be skipped by caller", source);
        }

        return result;
    }

    /**
     * Looks up the Shopify variant ID for a given SKU by consulting the Product DB.
     * Returns null if the product isn't found or doesn't have a variant ID — in that
     * case the line item will be created as a custom item (no product link).
     */
    private String resolveShopifyVariantId(String sku) {
        if (sku == null || sku.isBlank()) return null;
        return productRepository.findBySku(sku)
            .map(p -> p.getShopifyVariantId())
            .orElse(null);
    }

    private String nvl(String value, String fallback) {
        return value != null ? value : fallback;
    }
}
