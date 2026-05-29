package com.gearline.marketplace.reverb.mapper;

import com.gearline.domain.order.BuyerInfo;
import com.gearline.domain.order.OrderLineItem;
import com.gearline.domain.order.ShippingAddress;
import com.gearline.marketplace.common.dto.ImportedOrder;
import com.gearline.marketplace.reverb.dto.ReverbListingDto;
import com.gearline.marketplace.reverb.dto.ReverbOrderDto;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * Maps Reverb order API responses to the internal ImportedOrder model.
 */
@Component
@Slf4j
public class ReverbOrderMapper {

    public ImportedOrder toImportedOrder(ReverbOrderDto dto) {
        return ImportedOrder.builder()
            .externalOrderId(dto.getId())
            .marketplaceOrderUrl(extractOrderUrl(dto))
            .lineItems(mapLineItems(dto))
            .subtotal(parseMoney(dto.getAmountProduct()))
            .shippingTotal(parseMoney(dto.getAmountShipping()))
            .taxTotal(parseMoney(dto.getAmountTax()))
            .totalAmount(parseMoney(dto.getAmountTotal()))
            .currency("USD")
            .buyerInfo(mapBuyerInfo(dto))
            .shippingAddress(mapShippingAddress(dto.getShippingAddress()))
            .createdAt(parseDate(dto.getCreatedAt()))
            .build();
    }

    /**
     * Reverb orders are single-item: the sold listing lives in dto.listing.
     * We build one OrderLineItem from it, using amount_product as the unit price.
     * The SKU is used downstream to look up the matching Product in our DB.
     */
    private List<OrderLineItem> mapLineItems(ReverbOrderDto dto) {
        ReverbOrderDto.ReverbOrderListing listing = dto.getListing();
        if (listing == null) {
            log.warn("Reverb order {} has no listing object — line items will be empty", dto.getId());
            return List.of();
        }

        int qty = dto.getQuantity() != null && dto.getQuantity() > 0 ? dto.getQuantity() : 1;

        OrderLineItem item = OrderLineItem.builder()
            .externalListingId(listing.getId())
            .sku(listing.getSku())
            .title(listing.getTitle())
            .quantity(qty)
            .unitPrice(parseMoney(dto.getAmountProduct()))
            .build();

        return List.of(item);
    }

    private BuyerInfo mapBuyerInfo(ReverbOrderDto dto) {
        String firstName = "", lastName = "";
        if (dto.getBuyerName() != null) {
            String[] parts = dto.getBuyerName().split(" ", 2);
            firstName = parts[0];
            lastName = parts.length > 1 ? parts[1] : "";
        }
        return BuyerInfo.builder()
            .externalBuyerId(dto.getBuyerId())
            .username(dto.getBuyerName())
            .email(dto.getBuyerEmail())
            .firstName(firstName)
            .lastName(lastName)
            .build();
    }

    private ShippingAddress mapShippingAddress(ReverbOrderDto.ReverbShippingAddress addr) {
        if (addr == null) return null;
        return ShippingAddress.builder()
            .line1(addr.getStreet_address())
            .line2(addr.getExtended_address())
            .city(addr.getLocality())
            .state(addr.getRegion())
            .postalCode(addr.getPostalCode())
            .country(addr.getCountryCode())
            .build();
    }

    private BigDecimal parseMoney(ReverbListingDto.ReverbPrice price) {
        if (price == null || price.getAmount() == null) return BigDecimal.ZERO;
        try {
            return new BigDecimal(price.getAmount());
        } catch (NumberFormatException e) {
            log.warn("Could not parse Reverb price amount: {}", price.getAmount());
            return BigDecimal.ZERO;
        }
    }

    private String extractOrderUrl(ReverbOrderDto dto) {
        if (dto.getLinks() != null && dto.getLinks().getWeb() != null) {
            return dto.getLinks().getWeb().getHref();
        }
        return null;
    }

    private Instant parseDate(String dateStr) {
        if (dateStr == null) return Instant.now();
        try {
            return Instant.parse(dateStr);
        } catch (Exception e) {
            return Instant.now();
        }
    }
}
