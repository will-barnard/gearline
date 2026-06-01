package com.gearline.marketplace.ebay.connector;

import com.gearline.marketplace.common.dto.ImportedOrder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class EbayOrderMapperTest {

    private EbayOrderMapper mapper;

    @BeforeEach
    void setUp() {
        mapper = new EbayOrderMapper();
    }

    @Test
    void map_fullOrder_populatesAllFields() {
        Map<String, Object> raw = buildFullOrder();
        ImportedOrder order = mapper.map(raw);

        assertThat(order).isNotNull();
        assertThat(order.getExternalOrderId()).isEqualTo("12-34567-89012");
        assertThat(order.getCreatedAt().toString()).startsWith("2024-01-15T10:30:00");
    }

    @Test
    void map_buyerFields_parsedCorrectly() {
        ImportedOrder order = mapper.map(buildFullOrder());

        assertThat(order.getBuyerInfo()).isNotNull();
        assertThat(order.getBuyerInfo().getUsername()).isEqualTo("buyer_user");
        assertThat(order.getBuyerInfo().getEmail()).isEqualTo("buyer@example.com");
        assertThat(order.getBuyerInfo().getFirstName()).isEqualTo("John");
        assertThat(order.getBuyerInfo().getLastName()).isEqualTo("Doe");
        assertThat(order.getBuyerInfo().getPhone()).isEqualTo("555-1234");
    }

    @Test
    void map_shippingAddress_parsedCorrectly() {
        ImportedOrder order = mapper.map(buildFullOrder());

        assertThat(order.getShippingAddress()).isNotNull();
        assertThat(order.getShippingAddress().getLine1()).isEqualTo("123 Main St");
        assertThat(order.getShippingAddress().getCity()).isEqualTo("Springfield");
        assertThat(order.getShippingAddress().getState()).isEqualTo("IL");
        assertThat(order.getShippingAddress().getPostalCode()).isEqualTo("62701");
        assertThat(order.getShippingAddress().getCountry()).isEqualTo("US");
    }

    @Test
    void map_lineItems_parsedCorrectly() {
        ImportedOrder order = mapper.map(buildFullOrder());

        assertThat(order.getLineItems()).hasSize(1);
        var item = order.getLineItems().get(0);
        assertThat(item.getSku()).isEqualTo("GEARLINE-SKU-001");
        assertThat(item.getTitle()).isEqualTo("Gibson Les Paul Standard");
        assertThat(item.getQuantity()).isEqualTo(1);
        assertThat(item.getUnitPrice()).isEqualByComparingTo(new BigDecimal("1500.00"));
        assertThat(item.getLineTotal()).isEqualByComparingTo(new BigDecimal("1500.00"));
    }

    @Test
    void map_pricingSummary_parsedCorrectly() {
        ImportedOrder order = mapper.map(buildFullOrder());

        assertThat(order.getSubtotal()).isEqualByComparingTo(new BigDecimal("1500.00"));
        assertThat(order.getShippingTotal()).isEqualByComparingTo(new BigDecimal("25.00"));
        assertThat(order.getTaxTotal()).isEqualByComparingTo(BigDecimal.ZERO);
        assertThat(order.getTotalAmount()).isEqualByComparingTo(new BigDecimal("1525.00"));
        assertThat(order.getCurrency()).isEqualTo("USD");
    }

    @Test
    void map_nullInput_returnsNull() {
        assertThat(mapper.map(null)).isNull();
    }

    @Test
    void map_missingBuyer_stillReturnsOrder() {
        Map<String, Object> raw = buildFullOrder();
        ((java.util.LinkedHashMap<?, ?>) raw).remove("buyer");
        ImportedOrder order = mapper.map(raw);
        assertThat(order).isNotNull();
        assertThat(order.getBuyerInfo()).isNull();
    }

    @Test
    void map_missingFulfillmentInstructions_shippingAddressIsNull() {
        Map<String, Object> raw = buildFullOrder();
        ((java.util.LinkedHashMap<?, ?>) raw).remove("fulfillmentStartInstructions");
        ImportedOrder order = mapper.map(raw);
        assertThat(order).isNotNull();
        assertThat(order.getShippingAddress()).isNull();
    }

    @Test
    void map_singleNameBuyer_firstNameSetLastNameEmpty() {
        var raw = buildFullOrder();
        @SuppressWarnings("unchecked")
        var buyer = (java.util.Map<String, Object>) raw.get("buyer");
        @SuppressWarnings("unchecked")
        var regAddr = (java.util.Map<String, Object>) buyer.get("buyerRegistrationAddress");
        ((java.util.LinkedHashMap<String, Object>) regAddr).put("fullName", "Madonna");
        ImportedOrder order = mapper.map(raw);
        assertThat(order.getBuyerInfo().getFirstName()).isEqualTo("Madonna");
        assertThat(order.getBuyerInfo().getLastName()).isEqualTo("");
    }

    @Test
    void map_marketplaceOrderUrl_containsOrderId() {
        ImportedOrder order = mapper.map(buildFullOrder());
        assertThat(order.getMarketplaceOrderUrl()).contains("12-34567-89012");
    }

    // ── Test fixture ───────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private java.util.LinkedHashMap<String, Object> buildFullOrder() {
        var order = new java.util.LinkedHashMap<String, Object>();
        order.put("orderId", "12-34567-89012");
        order.put("creationDate", "2024-01-15T10:30:00.000Z");

        var primaryPhone = new java.util.LinkedHashMap<String, Object>();
        primaryPhone.put("phoneNumber", "555-1234");

        var regAddr = new java.util.LinkedHashMap<String, Object>();
        regAddr.put("fullName", "John Doe");
        regAddr.put("email", "buyer@example.com");
        regAddr.put("primaryPhone", primaryPhone);

        var buyer = new java.util.LinkedHashMap<String, Object>();
        buyer.put("username", "buyer_user");
        buyer.put("buyerRegistrationAddress", regAddr);
        order.put("buyer", buyer);

        var contactAddress = new java.util.LinkedHashMap<String, Object>();
        contactAddress.put("addressLine1", "123 Main St");
        contactAddress.put("addressLine2", null);
        contactAddress.put("city", "Springfield");
        contactAddress.put("stateOrProvince", "IL");
        contactAddress.put("postalCode", "62701");
        contactAddress.put("countryCode", "US");

        var shipTo = new java.util.LinkedHashMap<String, Object>();
        shipTo.put("contactAddress", contactAddress);

        var shippingStep = new java.util.LinkedHashMap<String, Object>();
        shippingStep.put("shipTo", shipTo);

        var instruction = new java.util.LinkedHashMap<String, Object>();
        instruction.put("shippingStep", shippingStep);
        order.put("fulfillmentStartInstructions", List.of(instruction));

        var lineItemCost = Map.of("value", "1500.00", "currency", "USD");
        var lineItem = new java.util.LinkedHashMap<String, Object>();
        lineItem.put("lineItemId", "li-001");
        lineItem.put("sku", "GEARLINE-SKU-001");
        lineItem.put("title", "Gibson Les Paul Standard");
        lineItem.put("quantity", 1);
        lineItem.put("lineItemCost", lineItemCost);
        order.put("lineItems", List.of(lineItem));

        order.put("pricingSummary", Map.of(
            "priceSubtotal", Map.of("value", "1500.00", "currency", "USD"),
            "deliveryCost",  Map.of("value", "25.00",   "currency", "USD"),
            "tax",           Map.of("value", "0.00",    "currency", "USD"),
            "total",         Map.of("value", "1525.00", "currency", "USD")
        ));

        return order;
    }
}
