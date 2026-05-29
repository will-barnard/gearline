package com.gearline.api.orders;

import com.gearline.domain.order.*;
import com.gearline.marketplace.common.connector.MarketplaceType;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record OrderDto(
    UUID id,
    String externalOrderId,
    UUID marketplaceAccountId,
    MarketplaceType marketplaceType,
    OrderStatus orderStatus,
    List<OrderLineItem> lineItems,
    BigDecimal subtotal,
    BigDecimal shippingTotal,
    BigDecimal taxTotal,
    BigDecimal totalAmount,
    String currency,
    BuyerInfo buyerInfo,
    ShippingAddress shippingAddress,
    String marketplaceOrderUrl,
    Instant importedAt,
    Instant createdAt
) {
    public static OrderDto from(Order o) {
        return new OrderDto(
            o.getId(), o.getExternalOrderId(), o.getMarketplaceAccountId(),
            o.getMarketplaceType(), o.getOrderStatus(), o.getLineItems(),
            o.getSubtotal(), o.getShippingTotal(), o.getTaxTotal(), o.getTotalAmount(),
            o.getCurrency(), o.getBuyerInfo(), o.getShippingAddress(),
            o.getMarketplaceOrderUrl(), o.getImportedAt(), o.getCreatedAt()
        );
    }
}
