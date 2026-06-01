package com.gearline.service;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.order.Order;
import com.gearline.domain.order.OrderStatus;
import com.gearline.infrastructure.persistence.OrderRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.common.dto.ImportedOrder;
import com.gearline.marketplace.shopify.order.ShopifyOrderPushService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class OrderImportServiceTest {

    @Mock private OrderRepository orderRepository;
    @Mock private InventoryConsistencyService inventoryConsistencyService;
    @Mock private ShopifyOrderPushService shopifyOrderPushService;

    @InjectMocks
    private OrderImportService service;

    private MarketplaceAccount reverbAccount;

    @BeforeEach
    void setUp() {
        reverbAccount = MarketplaceAccount.builder()
            .id(UUID.randomUUID())
            .marketplaceType(MarketplaceType.REVERB)
            .displayName("Test Reverb Account")
            .build();
    }

    // ── Deduplication ─────────────────────────────────────────────────────────

    @Test
    void importOrder_duplicateOrder_skipsAndReturnsNull() {
        when(orderRepository.existsByMarketplaceTypeAndExternalOrderId(
            MarketplaceType.REVERB, "reverb-order-001")).thenReturn(true);

        Order result = service.importOrder(buildImportedOrder("reverb-order-001"), reverbAccount);

        assertThat(result).isNull();
        verify(orderRepository, never()).save(any());
        verify(inventoryConsistencyService, never()).handleOrderImported(any(), any());
        verify(shopifyOrderPushService, never()).pushToShopify(any(), any(), any());
    }

    @Test
    void importOrder_newOrder_persistsAndReturnsOrder() {
        when(orderRepository.existsByMarketplaceTypeAndExternalOrderId(any(), any())).thenReturn(false);
        Order saved = Order.builder()
            .id(UUID.randomUUID())
            .externalOrderId("reverb-order-002")
            .orderStatus(OrderStatus.IMPORTED)
            .build();
        when(orderRepository.save(any(Order.class))).thenReturn(saved);

        Order result = service.importOrder(buildImportedOrder("reverb-order-002"), reverbAccount);

        assertThat(result).isNotNull();
        assertThat(result.getExternalOrderId()).isEqualTo("reverb-order-002");
        verify(orderRepository).save(any(Order.class));
    }

    @Test
    void importOrder_newOrder_mapsFieldsCorrectly() {
        when(orderRepository.existsByMarketplaceTypeAndExternalOrderId(any(), any())).thenReturn(false);
        when(orderRepository.save(any(Order.class))).thenAnswer(i -> i.getArgument(0));

        ImportedOrder imported = buildImportedOrder("reverb-order-003");
        service.importOrder(imported, reverbAccount);

        var captor = org.mockito.ArgumentCaptor.forClass(Order.class);
        verify(orderRepository).save(captor.capture());
        Order saved = captor.getValue();

        assertThat(saved.getMarketplaceType()).isEqualTo(MarketplaceType.REVERB);
        assertThat(saved.getMarketplaceAccountId()).isEqualTo(reverbAccount.getId());
        assertThat(saved.getOrderStatus()).isEqualTo(OrderStatus.IMPORTED);
        assertThat(saved.getTotalAmount()).isEqualByComparingTo(new BigDecimal("825.00"));
        assertThat(saved.getCurrency()).isEqualTo("USD");
    }

    // ── Resilience — downstream failures don't lose the order ─────────────────

    @Test
    void importOrder_inventoryFailure_orderStillPersisted() {
        when(orderRepository.existsByMarketplaceTypeAndExternalOrderId(any(), any())).thenReturn(false);
        when(orderRepository.save(any(Order.class))).thenAnswer(i -> i.getArgument(0));
        doThrow(new RuntimeException("inventory error"))
            .when(inventoryConsistencyService).handleOrderImported(any(), any());

        Order result = service.importOrder(buildImportedOrder("reverb-order-004"), reverbAccount);

        assertThat(result).isNotNull(); // order persisted despite inventory failure
        verify(orderRepository).save(any());
    }

    @Test
    void importOrder_shopifyPushFailure_orderStillPersisted() {
        when(orderRepository.existsByMarketplaceTypeAndExternalOrderId(any(), any())).thenReturn(false);
        when(orderRepository.save(any(Order.class))).thenAnswer(i -> i.getArgument(0));
        doThrow(new RuntimeException("shopify push error"))
            .when(shopifyOrderPushService).pushToShopify(any(), any(), any());

        Order result = service.importOrder(buildImportedOrder("reverb-order-005"), reverbAccount);

        assertThat(result).isNotNull();
        verify(orderRepository).save(any());
    }

    @Test
    void importOrder_newOrder_triggersInventoryConsistency() {
        when(orderRepository.existsByMarketplaceTypeAndExternalOrderId(any(), any())).thenReturn(false);
        when(orderRepository.save(any(Order.class))).thenAnswer(i -> i.getArgument(0));

        ImportedOrder imported = buildImportedOrder("reverb-order-006");
        service.importOrder(imported, reverbAccount);

        verify(inventoryConsistencyService).handleOrderImported(eq(imported), eq(reverbAccount));
    }

    @Test
    void importOrder_nullCurrency_defaultsToUsd() {
        when(orderRepository.existsByMarketplaceTypeAndExternalOrderId(any(), any())).thenReturn(false);
        when(orderRepository.save(any(Order.class))).thenAnswer(i -> i.getArgument(0));

        ImportedOrder imported = ImportedOrder.builder()
            .externalOrderId("reverb-order-007")
            .currency(null)
            .subtotal(BigDecimal.ZERO)
            .shippingTotal(BigDecimal.ZERO)
            .taxTotal(BigDecimal.ZERO)
            .totalAmount(BigDecimal.ZERO)
            .lineItems(List.of())
            .createdAt(Instant.now())
            .build();
        service.importOrder(imported, reverbAccount);

        var captor = org.mockito.ArgumentCaptor.forClass(Order.class);
        verify(orderRepository).save(captor.capture());
        assertThat(captor.getValue().getCurrency()).isEqualTo("USD");
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────

    private ImportedOrder buildImportedOrder(String orderId) {
        return ImportedOrder.builder()
            .externalOrderId(orderId)
            .marketplaceOrderUrl("https://reverb.com/my/orders/" + orderId)
            .subtotal(new BigDecimal("800.00"))
            .shippingTotal(new BigDecimal("25.00"))
            .taxTotal(BigDecimal.ZERO)
            .totalAmount(new BigDecimal("825.00"))
            .currency("USD")
            .lineItems(List.of())
            .createdAt(Instant.now())
            .build();
    }
}
