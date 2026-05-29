package com.gearline.domain.order;

import com.gearline.domain.audit.AuditableEntity;
import com.gearline.marketplace.common.connector.MarketplaceType;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "orders", indexes = {
    @Index(name = "idx_orders_external_id", columnList = "external_order_id"),
    @Index(name = "idx_orders_marketplace_type", columnList = "marketplace_type"),
    @Index(name = "idx_orders_status", columnList = "order_status"),
    @Index(name = "idx_orders_account_id", columnList = "marketplace_account_id"),
    @Index(name = "idx_orders_type_external", columnList = "marketplace_type, external_order_id", unique = true)
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
@EqualsAndHashCode(of = "id", callSuper = false)
public class Order extends AuditableEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(name = "external_order_id", nullable = false, length = 200)
    private String externalOrderId;

    @Column(name = "marketplace_account_id", nullable = false)
    private UUID marketplaceAccountId;

    @Enumerated(EnumType.STRING)
    @Column(name = "marketplace_type", nullable = false, length = 30)
    private MarketplaceType marketplaceType;

    @Enumerated(EnumType.STRING)
    @Column(name = "order_status", nullable = false, length = 30)
    @Builder.Default
    private OrderStatus orderStatus = OrderStatus.IMPORTED;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "line_items", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private List<OrderLineItem> lineItems = new ArrayList<>();

    @Column(name = "subtotal", precision = 10, scale = 2)
    private BigDecimal subtotal;

    @Column(name = "shipping_total", precision = 10, scale = 2)
    private BigDecimal shippingTotal;

    @Column(name = "tax_total", precision = 10, scale = 2)
    private BigDecimal taxTotal;

    @Column(name = "total_amount", precision = 10, scale = 2)
    private BigDecimal totalAmount;

    @Column(name = "currency", length = 3)
    @Builder.Default
    private String currency = "USD";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "buyer_info", columnDefinition = "jsonb")
    private BuyerInfo buyerInfo;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "shipping_address", columnDefinition = "jsonb")
    private ShippingAddress shippingAddress;

    @Column(name = "marketplace_order_url", length = 500)
    private String marketplaceOrderUrl;

    @Column(name = "imported_at", nullable = false)
    private Instant importedAt;

    @Column(name = "fulfilled_at")
    private Instant fulfilledAt;

    @Version
    private Long version;
}
