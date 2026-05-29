package com.gearline.domain.order;

public enum OrderStatus {
    IMPORTED,
    ACKNOWLEDGED,
    PROCESSING,
    SHIPPED,
    DELIVERED,
    CANCELLED,
    REFUNDED,
    DISPUTED
}
