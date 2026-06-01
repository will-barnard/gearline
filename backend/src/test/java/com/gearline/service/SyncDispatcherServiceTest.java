package com.gearline.service;

import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.MarketplaceListingRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.marketplace.common.connector.MarketplaceConnector;
import com.gearline.marketplace.common.connector.MarketplaceConnectorRegistry;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.common.dto.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Verifies that SyncDispatcherService routes each job type to the correct
 * connector method and persists the resulting listing state correctly.
 *
 * All dependencies are mocked — no Spring context, no database.
 */
class SyncDispatcherServiceTest {

    private MarketplaceConnectorRegistry connectorRegistry;
    private MarketplaceAccountRepository accountRepository;
    private MarketplaceListingRepository listingRepository;
    private ProductRepository productRepository;
    private InventoryConsistencyService inventoryConsistencyService;
    private ListingAttributeResolver listingAttributeResolver;
    private OrderImportService orderImportService;
    private MarketplaceConnector connector;

    private SyncDispatcherService dispatcher;

    // Fixed IDs used across tests
    private final UUID accountId = UUID.randomUUID();
    private final UUID productId = UUID.randomUUID();
    private final UUID listingId = UUID.randomUUID();

    private MarketplaceAccount account;
    private Product product;
    private MarketplaceListing listing;
    private PublishListingRequest resolvedRequest;

    @BeforeEach
    void setUp() {
        connectorRegistry = mock(MarketplaceConnectorRegistry.class);
        accountRepository = mock(MarketplaceAccountRepository.class);
        listingRepository = mock(MarketplaceListingRepository.class);
        productRepository = mock(ProductRepository.class);
        inventoryConsistencyService = mock(InventoryConsistencyService.class);
        listingAttributeResolver = mock(ListingAttributeResolver.class);
        orderImportService = mock(OrderImportService.class);
        connector = mock(MarketplaceConnector.class);

        dispatcher = new SyncDispatcherService(
            connectorRegistry, accountRepository, listingRepository,
            productRepository, inventoryConsistencyService,
            listingAttributeResolver, orderImportService
        );

        account = mock(MarketplaceAccount.class);

        product = Product.builder()
            .sku("TEST-SKU")
            .title("Test Guitar")
            .price(new BigDecimal("799.00"))
            .quantity(3)
            .condition(ProductCondition.EXCELLENT)
            .build();

        listing = MarketplaceListing.builder()
            .id(listingId)
            .productId(productId)
            .marketplaceAccountId(accountId)
            .marketplaceType(MarketplaceType.REVERB)
            .listingStatus(ListingStatus.PENDING)
            .errorCount(0)
            .build();

        resolvedRequest = PublishListingRequest.builder().quantity(3).build();

        when(accountRepository.findById(accountId)).thenReturn(Optional.of(account));
        when(productRepository.findById(productId)).thenReturn(Optional.of(product));
        when(listingRepository.findById(listingId)).thenReturn(Optional.of(listing));
        when(connectorRegistry.getConnector(MarketplaceType.REVERB)).thenReturn(connector);
        when(listingAttributeResolver.resolve(any(), any())).thenReturn(resolvedRequest);
        when(listingRepository.findByProductIdAndMarketplaceAccountId(any(), any()))
            .thenReturn(Optional.of(listing));
    }

    // ── LISTING_PUBLISH ────────────────────────────────────────────────────────

    @Test
    void publishListing_callsConnectorAndSavesActiveStatus_onSuccess() {
        PublishListingResult success = PublishListingResult.success(
            "reverb-123", new BigDecimal("799.00"), 3, Map.of("reverb_id", "reverb-123"));
        when(connector.publishListing(eq(account), eq(product), eq(resolvedRequest)))
            .thenReturn(success);

        dispatcher.dispatch(job(SyncJobType.LISTING_PUBLISH));

        verify(connector).publishListing(account, product, resolvedRequest);
        verify(listingRepository).save(argThat(l ->
            l.getListingStatus() == ListingStatus.ACTIVE
                && "reverb-123".equals(l.getExternalListingId())
                && l.getLastError() == null
        ));
    }

    @Test
    void publishListing_savesFailedStatus_whenConnectorFails() {
        when(connector.publishListing(any(), any(), any()))
            .thenReturn(PublishListingResult.failure("Token expired"));

        dispatcher.dispatch(job(SyncJobType.LISTING_PUBLISH));

        verify(listingRepository).save(argThat(l ->
            l.getListingStatus() == ListingStatus.FAILED
                && "Token expired".equals(l.getLastError())
                && l.getErrorCount() == 1
        ));
    }

    @Test
    void publishListing_createsNewListingShell_whenNoExistingRecord() {
        // No existing listing — dispatcher should build a new shell and save it
        when(listingRepository.findByProductIdAndMarketplaceAccountId(any(), any()))
            .thenReturn(Optional.empty());
        when(connector.publishListing(any(), any(), any()))
            .thenReturn(PublishListingResult.success("new-id", new BigDecimal("799.00"), 3, Map.of()));

        dispatcher.dispatch(job(SyncJobType.LISTING_PUBLISH));

        verify(listingRepository).save(argThat(l ->
            l.getListingStatus() == ListingStatus.ACTIVE
                && "new-id".equals(l.getExternalListingId())
        ));
    }

    // ── LISTING_UPDATE ─────────────────────────────────────────────────────────

    @Test
    void updateListing_callsConnectorAndSavesActiveStatus_onSuccess() {
        when(connector.updateListing(eq(account), eq(product), eq(listing), eq(resolvedRequest)))
            .thenReturn(PublishListingResult.success(null, new BigDecimal("750.00"), 2, Map.of()));

        dispatcher.dispatch(job(SyncJobType.LISTING_UPDATE));

        verify(connector).updateListing(account, product, listing, resolvedRequest);
        verify(listingRepository).save(argThat(l ->
            l.getListingStatus() == ListingStatus.ACTIVE && l.getLastError() == null
        ));
    }

    @Test
    void updateListing_incrementsErrorCount_onFailure() {
        listing.setErrorCount(2);
        when(connector.updateListing(any(), any(), any(), any()))
            .thenReturn(PublishListingResult.failure("Server error"));

        dispatcher.dispatch(job(SyncJobType.LISTING_UPDATE));

        verify(listingRepository).save(argThat(l ->
            l.getListingStatus() == ListingStatus.FAILED && l.getErrorCount() == 3
        ));
    }

    // ── LISTING_DELIST ─────────────────────────────────────────────────────────

    @Test
    void delistListing_callsConnectorAndSavesDelistedStatus() {
        doNothing().when(connector).delistListing(any(), any());

        dispatcher.dispatch(job(SyncJobType.LISTING_DELIST));

        verify(connector).delistListing(account, listing);
        verify(listingRepository).save(argThat(l ->
            l.getListingStatus() == ListingStatus.DELISTED
        ));
    }

    // ── INVENTORY_SYNC ─────────────────────────────────────────────────────────

    @Test
    void syncInventory_usesProductQuantityAndSavesSyncedQty() {
        product.setQuantity(7);
        when(connector.syncInventory(eq(account), eq(listing), eq(7)))
            .thenReturn(InventorySyncResult.success(7));

        dispatcher.dispatch(job(SyncJobType.INVENTORY_SYNC));

        verify(connector).syncInventory(account, listing, 7);
        verify(listingRepository).save(argThat(l ->
            l.getSyncedQuantity() == 7 && l.getLastError() == null
        ));
    }

    @Test
    void syncInventory_setsLastError_onFailure() {
        when(connector.syncInventory(any(), any(), anyInt()))
            .thenReturn(InventorySyncResult.failure("Rate limit exceeded"));

        dispatcher.dispatch(job(SyncJobType.INVENTORY_SYNC));

        verify(listingRepository).save(argThat(l ->
            "Rate limit exceeded".equals(l.getLastError())
        ));
    }

    // ── ORDER_IMPORT ───────────────────────────────────────────────────────────

    @Test
    void importOrder_fetchesFromConnectorAndPassesToImportService() {
        ImportedOrder order = ImportedOrder.builder()
            .externalOrderId("ext-order-99")
            .build();
        when(connector.importOrder(eq(account), eq("ext-order-99"))).thenReturn(order);

        SyncJob orderJob = job(SyncJobType.ORDER_IMPORT);
        orderJob.setPayload(Map.of("externalOrderId", "ext-order-99"));

        dispatcher.dispatch(orderJob);

        verify(connector).importOrder(account, "ext-order-99");
        verify(orderImportService).importOrder(order, account);
    }

    // ── Missing entities ───────────────────────────────────────────────────────

    @Test
    void dispatch_throwsIllegalArgument_whenAccountNotFound() {
        when(accountRepository.findById(accountId)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> dispatcher.dispatch(job(SyncJobType.LISTING_PUBLISH)))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("MarketplaceAccount not found");
    }

    @Test
    void dispatch_throwsIllegalArgument_whenProductNotFound() {
        when(productRepository.findById(productId)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> dispatcher.dispatch(job(SyncJobType.LISTING_PUBLISH)))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("Product not found");
    }

    // ── Helper ─────────────────────────────────────────────────────────────────

    private SyncJob job(SyncJobType type) {
        return SyncJob.builder()
            .jobType(type)
            .marketplaceType(MarketplaceType.REVERB)
            .marketplaceAccountId(accountId)
            .productId(productId)
            .listingId(listingId)
            .build();
    }
}
