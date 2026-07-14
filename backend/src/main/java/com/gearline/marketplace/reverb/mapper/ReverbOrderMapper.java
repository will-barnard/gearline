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

    /**
     * Maps a Reverb order DTO to our internal ImportedOrder.
     *
     * Returns {@code null} if the order has no identifiable ID — callers
     * (ReverbConnector.importOrders) must filter these out so they are never
     * passed to OrderImportService.
     */
    public ImportedOrder toImportedOrder(ReverbOrderDto dto) {
        // Resolve the order ID: primary is dto.getId() (mapped from JSON "order_id").
        // Fallback: extract the numeric ID from the order URL, which Reverb always
        // includes in the _links.web.href even when the id field is missing.
        // URL format: https://reverb.com/my/selling/orders/25262223
        String orderId = dto.getId();
        String orderUrl = extractOrderUrl(dto);

        if (orderId == null || orderId.isBlank()) {
            if (orderUrl != null) {
                int lastSlash = orderUrl.lastIndexOf('/');
                if (lastSlash >= 0 && lastSlash < orderUrl.length() - 1) {
                    orderId = orderUrl.substring(lastSlash + 1);
                    log.debug("Reverb order: extracted ID '{}' from URL (order_id field was null)", orderId);
                }
            }
        }

        if (orderId == null || orderId.isBlank()) {
            log.warn("Reverb order has no identifiable ID (order_id field null, no URL) — skipping");
            return null;
        }

        return ImportedOrder.builder()
            .externalOrderId(orderId)
            .marketplaceOrderUrl(orderUrl)
            .lineItems(mapLineItems(dto, orderId))
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
    private List<OrderLineItem> mapLineItems(ReverbOrderDto dto, String resolvedOrderId) {
        ReverbOrderDto.ReverbOrderListing listing = dto.getListing();
        if (listing == null) {
            log.warn("Reverb order {} has no listing object — line items will be empty", resolvedOrderId);
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

    /**
     * Finding #28: return null when the date string is absent or unparseable.
     *
     * The previous implementation returned Instant.now() as a fallback, which
     * silently set createdAt to the webhook-processing time rather than the actual
     * order creation time. This polluted audit trails and order-date analytics.
     *
     * Returning null is the honest answer: callers must handle it explicitly
     * (e.g. leaving the field unset or logging a warning) rather than silently
     * receiving a wrong timestamp.
     */
    private Instant parseDate(String dateStr) {
        if (dateStr == null) return null;
        try {
            return Instant.parse(dateStr);
        } catch (Exception e) {
            log.warn("Could not parse Reverb date '{}': {}", dateStr, e.getMessage());
            return null;
        }
    }
}
