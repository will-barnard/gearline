package com.gearline.marketplace.reverb.mapper;

import com.gearline.marketplace.common.dto.ImportedOrder;
import com.gearline.marketplace.reverb.dto.ReverbListingDto;
import com.gearline.marketplace.reverb.dto.ReverbOrderDto;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;

class ReverbOrderMapperTest {

    private ReverbOrderMapper mapper;

    @BeforeEach
    void setUp() {
        mapper = new ReverbOrderMapper();
    }

    @Test
    void toImportedOrder_fullDto_populatesAllFields() {
        ReverbOrderDto dto = buildFullDto();
        ImportedOrder order = mapper.toImportedOrder(dto);

        assertThat(order.getExternalOrderId()).isEqualTo("reverb-order-001");
        assertThat(order.getCurrency()).isEqualTo("USD");
        assertThat(order.getCreatedAt()).isNotNull();
    }

    @Test
    void toImportedOrder_pricing_parsedCorrectly() {
        ImportedOrder order = mapper.toImportedOrder(buildFullDto());

        assertThat(order.getSubtotal()).isEqualByComparingTo(new BigDecimal("800.00"));
        assertThat(order.getShippingTotal()).isEqualByComparingTo(new BigDecimal("20.00"));
        assertThat(order.getTaxTotal()).isEqualByComparingTo(new BigDecimal("64.00"));
        assertThat(order.getTotalAmount()).isEqualByComparingTo(new BigDecimal("884.00"));
    }

    @Test
    void toImportedOrder_buyerName_splitIntoFirstLast() {
        ImportedOrder order = mapper.toImportedOrder(buildFullDto());

        assertThat(order.getBuyerInfo().getFirstName()).isEqualTo("Jane");
        assertThat(order.getBuyerInfo().getLastName()).isEqualTo("Smith");
        assertThat(order.getBuyerInfo().getEmail()).isEqualTo("jane@example.com");
    }

    @Test
    void toImportedOrder_shippingAddress_parsedCorrectly() {
        ImportedOrder order = mapper.toImportedOrder(buildFullDto());
        var addr = order.getShippingAddress();

        assertThat(addr).isNotNull();
        assertThat(addr.getLine1()).isEqualTo("456 Oak Ave");
        assertThat(addr.getCity()).isEqualTo("Nashville");
        assertThat(addr.getState()).isEqualTo("TN");
        assertThat(addr.getPostalCode()).isEqualTo("37201");
        assertThat(addr.getCountry()).isEqualTo("US");
    }

    @Test
    void toImportedOrder_lineItems_fromListing() {
        ImportedOrder order = mapper.toImportedOrder(buildFullDto());

        assertThat(order.getLineItems()).hasSize(1);
        var item = order.getLineItems().get(0);
        assertThat(item.getSku()).isEqualTo("REVERB-SKU-001");
        assertThat(item.getTitle()).isEqualTo("Fender Stratocaster");
        assertThat(item.getQuantity()).isEqualTo(1);
        assertThat(item.getUnitPrice()).isEqualByComparingTo(new BigDecimal("800.00"));
    }

    @Test
    void toImportedOrder_nullListing_emptyLineItems() {
        ReverbOrderDto dto = buildFullDto();
        dto.setListing(null);
        ImportedOrder order = mapper.toImportedOrder(dto);

        assertThat(order.getLineItems()).isEmpty();
    }

    @Test
    void toImportedOrder_nullPrices_defaultToZero() {
        ReverbOrderDto dto = buildFullDto();
        dto.setAmountTax(null);
        dto.setAmountShipping(null);
        ImportedOrder order = mapper.toImportedOrder(dto);

        assertThat(order.getTaxTotal()).isEqualByComparingTo(BigDecimal.ZERO);
        assertThat(order.getShippingTotal()).isEqualByComparingTo(BigDecimal.ZERO);
    }

    @Test
    void toImportedOrder_singleWordBuyerName_lastNameEmpty() {
        ReverbOrderDto dto = buildFullDto();
        dto.setBuyerName("Cher");
        ImportedOrder order = mapper.toImportedOrder(dto);

        assertThat(order.getBuyerInfo().getFirstName()).isEqualTo("Cher");
        assertThat(order.getBuyerInfo().getLastName()).isEqualTo("");
    }

    // ── Test fixture ───────────────────────────────────────────────────────────

    private ReverbOrderDto buildFullDto() {
        var dto = new ReverbOrderDto();
        dto.setId("reverb-order-001");
        dto.setBuyerName("Jane Smith");
        dto.setBuyerId("buyer-456");
        dto.setBuyerEmail("jane@example.com");
        dto.setCreatedAt("2024-03-10T14:00:00.000Z");
        dto.setQuantity(1);

        dto.setAmountProduct(price("800.00"));
        dto.setAmountShipping(price("20.00"));
        dto.setAmountTax(price("64.00"));
        dto.setAmountTotal(price("884.00"));

        var addr = new ReverbOrderDto.ReverbShippingAddress();
        addr.setStreet_address("456 Oak Ave");
        addr.setLocality("Nashville");
        addr.setRegion("TN");
        addr.setPostalCode("37201");
        addr.setCountryCode("US");
        dto.setShippingAddress(addr);

        var listing = new ReverbOrderDto.ReverbOrderListing();
        listing.setId("reverb-listing-001");
        listing.setSku("REVERB-SKU-001");
        listing.setTitle("Fender Stratocaster");
        dto.setListing(listing);

        return dto;
    }

    private ReverbListingDto.ReverbPrice price(String amount) {
        var p = new ReverbListingDto.ReverbPrice();
        p.setAmount(amount);
        p.setCurrency("USD");
        return p;
    }
}
