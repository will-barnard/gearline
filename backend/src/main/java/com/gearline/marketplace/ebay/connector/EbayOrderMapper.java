package com.gearline.marketplace.ebay.connector;

import com.gearline.domain.order.BuyerInfo;
import com.gearline.domain.order.OrderLineItem;
import com.gearline.domain.order.ShippingAddress;
import com.gearline.marketplace.common.dto.ImportedOrder;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Maps a raw eBay Fulfillment API order map to {@link ImportedOrder}.
 *
 * Expected input shape (eBay GET /sell/fulfillment/v1/order/{orderId}):
 * <pre>
 * {
 *   "orderId": "12-34567-89012",
 *   "creationDate": "2024-01-15T10:30:00.000Z",
 *   "buyer": {
 *     "username": "buyer_user",
 *     "buyerRegistrationAddress": {
 *       "fullName": "John Doe",
 *       "email": "buyer@example.com",
 *       "primaryPhone": { "phoneNumber": "555-1234" }
 *     }
 *   },
 *   "fulfillmentStartInstructions": [{
 *     "shippingStep": {
 *       "shipTo": {
 *         "contactAddress": {
 *           "addressLine1": "123 Main St",
 *           "addressLine2": "Apt 4",
 *           "city": "Springfield",
 *           "stateOrProvince": "IL",
 *           "postalCode": "62701",
 *           "countryCode": "US"
 *         }
 *       }
 *     }
 *   }],
 *   "lineItems": [{
 *     "lineItemId": "...",
 *     "sku": "GEARLINE-SKU-001",
 *     "title": "Gibson Les Paul Standard",
 *     "quantity": 1,
 *     "lineItemCost": { "value": "1500.00", "currency": "USD" }
 *   }],
 *   "pricingSummary": {
 *     "priceSubtotal": { "value": "1500.00", "currency": "USD" },
 *     "deliveryCost": { "value": "25.00",   "currency": "USD" },
 *     "tax":          { "value": "0.00",    "currency": "USD" },
 *     "total":        { "value": "1525.00", "currency": "USD" }
 *   }
 * }
 * </pre>
 */
@Component
@Slf4j
public class EbayOrderMapper {

    /**
     * Converts a raw eBay order map to a normalized {@link ImportedOrder}.
     *
     * @param raw the deserialized JSON object from the Fulfillment API
     * @return normalized order, or null if the order is malformed
     */
    @SuppressWarnings("unchecked")
    public ImportedOrder map(Map<String, Object> raw) {
        if (raw == null) return null;

        try {
            String orderId = (String) raw.get("orderId");
            String creationDateStr = (String) raw.get("creationDate");
            Instant createdAt = creationDateStr != null ? Instant.parse(creationDateStr) : Instant.now();

            // ── Buyer ──────────────────────────────────────────────────────────
            BuyerInfo buyerInfo = null;
            Map<String, Object> buyer = (Map<String, Object>) raw.get("buyer");
            if (buyer != null) {
                String username = (String) buyer.get("username");
                Map<String, Object> regAddr = (Map<String, Object>) buyer.get("buyerRegistrationAddress");
                String fullName = null;
                String email = null;
                String phone = null;
                if (regAddr != null) {
                    fullName = (String) regAddr.get("fullName");
                    email = (String) regAddr.get("email");
                    Map<String, Object> primaryPhone = (Map<String, Object>) regAddr.get("primaryPhone");
                    if (primaryPhone != null) {
                        phone = (String) primaryPhone.get("phoneNumber");
                    }
                }
                String[] nameParts = splitName(fullName);
                buyerInfo = BuyerInfo.builder()
                    .externalBuyerId(username)
                    .username(username)
                    .email(email)
                    .firstName(nameParts[0])
                    .lastName(nameParts[1])
                    .phone(phone)
                    .build();
            }

            // ── Shipping address ──────────────────────────────────────────────
            ShippingAddress shippingAddress = null;
            List<Map<String, Object>> fulfillmentInstructions =
                (List<Map<String, Object>>) raw.get("fulfillmentStartInstructions");
            if (fulfillmentInstructions != null && !fulfillmentInstructions.isEmpty()) {
                Map<String, Object> first = fulfillmentInstructions.get(0);
                Map<String, Object> shippingStep = (Map<String, Object>) first.get("shippingStep");
                if (shippingStep != null) {
                    Map<String, Object> shipTo = (Map<String, Object>) shippingStep.get("shipTo");
                    if (shipTo != null) {
                        Map<String, Object> addr = (Map<String, Object>) shipTo.get("contactAddress");
                        if (addr != null) {
                            shippingAddress = ShippingAddress.builder()
                                .line1((String) addr.get("addressLine1"))
                                .line2((String) addr.get("addressLine2"))
                                .city((String) addr.get("city"))
                                .state((String) addr.get("stateOrProvince"))
                                .postalCode((String) addr.get("postalCode"))
                                .country((String) addr.get("countryCode"))
                                .build();
                        }
                    }
                }
            }

            // ── Line items ────────────────────────────────────────────────────
            List<OrderLineItem> lineItems = new ArrayList<>();
            List<Map<String, Object>> rawItems = (List<Map<String, Object>>) raw.get("lineItems");
            if (rawItems != null) {
                for (Map<String, Object> item : rawItems) {
                    String sku = (String) item.get("sku");
                    String title = (String) item.get("title");
                    Integer qty = toInt(item.get("quantity"));
                    BigDecimal unitPrice = extractAmount((Map<String, Object>) item.get("lineItemCost"));
                    BigDecimal lineTotal = qty != null && unitPrice != null
                        ? unitPrice.multiply(BigDecimal.valueOf(qty))
                        : unitPrice;
                    String externalLineItemId = (String) item.get("lineItemId");

                    lineItems.add(OrderLineItem.builder()
                        .sku(sku)
                        .externalListingId(externalLineItemId)
                        .title(title)
                        .quantity(qty != null ? qty : 1)
                        .unitPrice(unitPrice)
                        .lineTotal(lineTotal)
                        .build());
                }
            }

            // ── Pricing summary ───────────────────────────────────────────────
            BigDecimal subtotal = BigDecimal.ZERO;
            BigDecimal shippingTotal = BigDecimal.ZERO;
            BigDecimal taxTotal = BigDecimal.ZERO;
            BigDecimal total = BigDecimal.ZERO;
            String currency = "USD";

            Map<String, Object> pricing = (Map<String, Object>) raw.get("pricingSummary");
            if (pricing != null) {
                subtotal = extractAmountOrZero((Map<String, Object>) pricing.get("priceSubtotal"));
                shippingTotal = extractAmountOrZero((Map<String, Object>) pricing.get("deliveryCost"));
                taxTotal = extractAmountOrZero((Map<String, Object>) pricing.get("tax"));
                total = extractAmountOrZero((Map<String, Object>) pricing.get("total"));
                // Derive currency from first available amount node
                currency = extractCurrency(pricing);
            }

            return ImportedOrder.builder()
                .externalOrderId(orderId)
                .marketplaceOrderUrl("https://www.ebay.com/order/" + orderId)
                .lineItems(lineItems)
                .subtotal(subtotal)
                .shippingTotal(shippingTotal)
                .taxTotal(taxTotal)
                .totalAmount(total)
                .currency(currency)
                .buyerInfo(buyerInfo)
                .shippingAddress(shippingAddress)
                .createdAt(createdAt)
                .build();

        } catch (Exception e) {
            log.error("Failed to map eBay order: {}", e.getMessage(), e);
            return null;
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private BigDecimal extractAmount(Map<String, Object> amountNode) {
        if (amountNode == null) return null;
        Object val = amountNode.get("value");
        if (val == null) return null;
        return new BigDecimal(val.toString());
    }

    private BigDecimal extractAmountOrZero(Map<String, Object> amountNode) {
        BigDecimal v = extractAmount(amountNode);
        return v != null ? v : BigDecimal.ZERO;
    }

    @SuppressWarnings("unchecked")
    private String extractCurrency(Map<String, Object> pricingSummary) {
        for (String key : List.of("priceSubtotal", "deliveryCost", "total", "tax")) {
            Object node = pricingSummary.get(key);
            if (node instanceof Map) {
                Object c = ((Map<String, Object>) node).get("currency");
                if (c instanceof String s && !s.isBlank()) return s;
            }
        }
        return "USD";
    }

    private Integer toInt(Object val) {
        if (val == null) return null;
        if (val instanceof Integer i) return i;
        if (val instanceof Number n) return n.intValue();
        try { return Integer.parseInt(val.toString()); } catch (Exception e) { return null; }
    }

    /**
     * Naively splits "First Last" into [first, last].
     * Returns ["", ""] for null; ["Name", ""] when only one word present.
     */
    private String[] splitName(String fullName) {
        if (fullName == null || fullName.isBlank()) return new String[]{"", ""};
        int space = fullName.indexOf(' ');
        if (space < 0) return new String[]{fullName, ""};
        return new String[]{fullName.substring(0, space), fullName.substring(space + 1)};
    }
}
