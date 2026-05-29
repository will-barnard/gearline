package com.gearline.marketplace.common.dto;

import com.gearline.domain.order.*;
import lombok.Builder;
import lombok.Value;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * Normalized order representation returned by all OrderImporter implementations.
 * Mapped from marketplace-specific API responses in the adapter layer.
 */
@Value
@Builder
public class ImportedOrder {
    String externalOrderId;
    String marketplaceOrderUrl;
    List<OrderLineItem> lineItems;
    BigDecimal subtotal;
    BigDecimal shippingTotal;
    BigDecimal taxTotal;
    BigDecimal totalAmount;
    String currency;
    BuyerInfo buyerInfo;
    ShippingAddress shippingAddress;
    Instant createdAt;
}
