package com.gearline.service;

import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.order.OrderLineItem;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.infrastructure.messaging.SyncJobProducer;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.MarketplaceListingRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.common.dto.ImportedOrder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.*;

/**
 * Unit tests for InventoryConsistencyService — cross-channel inventory propagation
 * and order-driven quantity deduction.
 */
class InventoryConsistencyServiceTest {

    private ProductRepository productRepository;
    private MarketplaceListingRepository listingRepository;
    private MarketplaceAccountRepository accountRepository;
    private SyncJobProducer syncJobProducer;
    private InventoryConsistencyService service;

    private final UUID productId = UUID.randomUUID();
    private Product product;

    @BeforeEach
    void setUp() {
        productRepository = mock(ProductRepository.class);
        listingRepository = mock(MarketplaceListingRepository.class);
        accountRepository = mock(MarketplaceAccountRepository.class);
        syncJobProducer = mock(SyncJobProducer.class);

        service = new InventoryConsistencyService(
            productRepository, listingRepository, accountRepository, syncJobProducer
        );

        product = Product.builder()
            .sku("GUITAR-001")
            .title("Test Guitar")
            .price(new BigDecimal("800.00"))
            .quantity(5)
            .condition(ProductCondition.EXCELLENT)
            .build();
        // Give it an ID via reflection workaround — use save mock return
        when(productRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    // ── propagateInventoryChange ───────────────────────────────────────────────

    @Test
    void propagateInventoryChange_updatesProductQuantity() {
        when(listingRepository.findActiveListingsForProduct(any())).thenReturn(List.of());

        service.propagateInventoryChange(product, 3);

        verify(productRepository).save(argThat(p -> p.getQuantity() == 3));
    }

    @Test
    void propagateInventoryChange_enqueuesInventorySyncJobForEachActiveListing() {
        UUID listingId1 = UUID.randomUUID();
        UUID listingId2 = UUID.randomUUID();
        UUID accountId = UUID.randomUUID();

        MarketplaceListing reverbListing = listing(listingId1, accountId, MarketplaceType.REVERB);
        MarketplaceListing ebayListing   = listing(listingId2, accountId, MarketplaceType.EBAY);

        when(listingRepository.findActiveListingsForProduct(any()))
            .thenReturn(List.of(reverbListing, ebayListing));

        service.propagateInventoryChange(product, 2);

        verify(syncJobProducer, times(2)).enqueue(any(SyncJob.class));
    }

    @Test
    void propagateInventoryChange_syncJobHasCorrectType_andMarketplace() {
        UUID listingId = UUID.randomUUID();
        MarketplaceListing listing = listing(listingId, UUID.randomUUID(), MarketplaceType.REVERB);
        when(listingRepository.findActiveListingsForProduct(any())).thenReturn(List.of(listing));

        service.propagateInventoryChange(product, 7);

        verify(syncJobProducer).enqueue(argThat(job ->
            job.getJobType() == SyncJobType.INVENTORY_SYNC
                && job.getMarketplaceType() == MarketplaceType.REVERB
                && job.getListingId().equals(listingId)
        ));
    }

    @Test
    void propagateInventoryChange_skipsShopifyListings() {
        MarketplaceListing shopifyListing = listing(UUID.randomUUID(), UUID.randomUUID(), MarketplaceType.SHOPIFY);
        MarketplaceListing reverbListing  = listing(UUID.randomUUID(), UUID.randomUUID(), MarketplaceType.REVERB);

        when(listingRepository.findActiveListingsForProduct(any()))
            .thenReturn(List.of(shopifyListing, reverbListing));

        service.propagateInventoryChange(product, 4);

        // Only one job — Shopify listing is skipped
        verify(syncJobProducer, times(1)).enqueue(argThat(job ->
            job.getMarketplaceType() == MarketplaceType.REVERB
        ));
    }

    @Test
    void propagateInventoryChange_noActiveListings_onlySavesProduct() {
        when(listingRepository.findActiveListingsForProduct(any())).thenReturn(List.of());

        service.propagateInventoryChange(product, 0);

        verify(productRepository).save(any());
        verify(syncJobProducer, never()).enqueue(any());
    }

    // ── handleOrderImported ────────────────────────────────────────────────────

    @Test
    void handleOrderImported_deductsQuantityFromProduct_byProductId() {
        product.setQuantity(5);
        UUID pid = UUID.randomUUID();

        OrderLineItem lineItem = OrderLineItem.builder()
            .productId(pid)
            .quantity(2)
            .build();
        ImportedOrder order = ImportedOrder.builder()
            .externalOrderId("reverb-order-1")
            .lineItems(List.of(lineItem))
            .build();

        when(productRepository.findById(pid)).thenReturn(Optional.of(product));
        when(listingRepository.findActiveListingsForProduct(any())).thenReturn(List.of());

        MarketplaceAccount account = mock(MarketplaceAccount.class);
        when(account.getMarketplaceType()).thenReturn(MarketplaceType.REVERB);

        service.handleOrderImported(order, account);

        // 5 - 2 = 3
        verify(productRepository).save(argThat(p -> p.getQuantity() == 3));
    }

    @Test
    void handleOrderImported_deductsQuantityFromProduct_bySkuFallback() {
        product.setQuantity(4);

        OrderLineItem lineItem = OrderLineItem.builder()
            .sku("GUITAR-001")
            .quantity(1)
            .build();
        ImportedOrder order = ImportedOrder.builder()
            .externalOrderId("ebay-order-2")
            .lineItems(List.of(lineItem))
            .build();

        when(productRepository.findBySku("GUITAR-001")).thenReturn(Optional.of(product));
        when(listingRepository.findActiveListingsForProduct(any())).thenReturn(List.of());

        MarketplaceAccount account = mock(MarketplaceAccount.class);
        when(account.getMarketplaceType()).thenReturn(MarketplaceType.EBAY);

        service.handleOrderImported(order, account);

        // 4 - 1 = 3
        verify(productRepository).save(argThat(p -> p.getQuantity() == 3));
    }

    @Test
    void handleOrderImported_quantityNeverGoesBelowZero() {
        product.setQuantity(1);

        OrderLineItem lineItem = OrderLineItem.builder()
            .sku("GUITAR-001")
            .quantity(5)  // more than in stock
            .build();
        ImportedOrder order = ImportedOrder.builder()
            .externalOrderId("order-oversell")
            .lineItems(List.of(lineItem))
            .build();

        when(productRepository.findBySku("GUITAR-001")).thenReturn(Optional.of(product));
        when(listingRepository.findActiveListingsForProduct(any())).thenReturn(List.of());

        MarketplaceAccount account = mock(MarketplaceAccount.class);
        when(account.getMarketplaceType()).thenReturn(MarketplaceType.REVERB);

        service.handleOrderImported(order, account);

        // min(0, 1 - 5) = 0
        verify(productRepository).save(argThat(p -> p.getQuantity() == 0));
    }

    @Test
    void handleOrderImported_skipsLineItem_whenProductNotFound() {
        OrderLineItem lineItem = OrderLineItem.builder()
            .sku("UNKNOWN-SKU")
            .quantity(1)
            .build();
        ImportedOrder order = ImportedOrder.builder()
            .externalOrderId("order-unknown")
            .lineItems(List.of(lineItem))
            .build();

        when(productRepository.findBySku("UNKNOWN-SKU")).thenReturn(Optional.empty());

        MarketplaceAccount account = mock(MarketplaceAccount.class);
        when(account.getMarketplaceType()).thenReturn(MarketplaceType.REVERB);

        service.handleOrderImported(order, account);

        verify(productRepository, never()).save(any());
        verify(syncJobProducer, never()).enqueue(any());
    }

    @Test
    void handleOrderImported_multipleLineItems_deductsEachIndependently() {
        UUID pid1 = UUID.randomUUID();
        UUID pid2 = UUID.randomUUID();

        Product product1 = productWithQty(pid1, 5);
        Product product2 = productWithQty(pid2, 3);

        when(productRepository.findById(pid1)).thenReturn(Optional.of(product1));
        when(productRepository.findById(pid2)).thenReturn(Optional.of(product2));
        when(listingRepository.findActiveListingsForProduct(any())).thenReturn(List.of());

        ImportedOrder order = ImportedOrder.builder()
            .externalOrderId("multi-line-order")
            .lineItems(List.of(
                OrderLineItem.builder().productId(pid1).quantity(2).build(),
                OrderLineItem.builder().productId(pid2).quantity(3).build()
            ))
            .build();

        MarketplaceAccount account = mock(MarketplaceAccount.class);
        when(account.getMarketplaceType()).thenReturn(MarketplaceType.EBAY);

        service.handleOrderImported(order, account);

        verify(productRepository).save(argThat(p -> p.getQuantity() == 3)); // 5 - 2
        verify(productRepository).save(argThat(p -> p.getQuantity() == 0)); // 3 - 3
    }

    @Test
    void handleOrderImported_nullQuantityInLineItem_defaultsToOne() {
        product.setQuantity(5);
        UUID pid = UUID.randomUUID();

        OrderLineItem lineItem = OrderLineItem.builder()
            .productId(pid)
            .quantity(null) // null quantity
            .build();
        ImportedOrder order = ImportedOrder.builder()
            .externalOrderId("null-qty-order")
            .lineItems(List.of(lineItem))
            .build();

        when(productRepository.findById(pid)).thenReturn(Optional.of(product));
        when(listingRepository.findActiveListingsForProduct(any())).thenReturn(List.of());

        MarketplaceAccount account = mock(MarketplaceAccount.class);
        when(account.getMarketplaceType()).thenReturn(MarketplaceType.REVERB);

        service.handleOrderImported(order, account);

        // null defaults to 1: 5 - 1 = 4
        verify(productRepository).save(argThat(p -> p.getQuantity() == 4));
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private MarketplaceListing listing(UUID id, UUID accountId, MarketplaceType type) {
        return MarketplaceListing.builder()
            .id(id)
            .productId(productId)
            .marketplaceAccountId(accountId)
            .marketplaceType(type)
            .listingStatus(ListingStatus.ACTIVE)
            .errorCount(0)
            .build();
    }

    private Product productWithQty(UUID id, int qty) {
        Product p = Product.builder()
            .sku("SKU-" + id)
            .title("Product " + id)
            .price(new BigDecimal("500.00"))
            .quantity(qty)
            .condition(ProductCondition.GOOD)
            .build();
        when(productRepository.save(p)).thenReturn(p);
        return p;
    }
}
