package com.gearline.infrastructure.persistence;

import com.gearline.domain.order.Order;
import com.gearline.domain.order.OrderStatus;
import com.gearline.marketplace.common.connector.MarketplaceType;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface OrderRepository extends JpaRepository<Order, UUID> {
    Optional<Order> findByMarketplaceTypeAndExternalOrderId(MarketplaceType type, String externalOrderId);
    boolean existsByMarketplaceTypeAndExternalOrderId(MarketplaceType type, String externalOrderId);
    Page<Order> findByOrderStatus(OrderStatus status, Pageable pageable);
    Page<Order> findByMarketplaceAccountId(UUID accountId, Pageable pageable);
}
