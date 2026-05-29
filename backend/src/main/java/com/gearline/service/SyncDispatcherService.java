package com.gearline.service;

import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Product;
import com.gearline.domain.sync.SyncJob;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.MarketplaceListingRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.marketplace.common.connector.MarketplaceConnector;
import com.gearline.marketplace.common.connector.MarketplaceConnectorRegistry;
import com.gearline.marketplace.common.dto.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Routes sync jobs to the appropriate connector action.
 * This is the central dispatch point for all async marketplace operations.
 *
 * Attribute resolution flow for publish/update:
 *   1. {@link ListingAttributeResolver} merges product defaults with the listing's
 *      {@code listing_overrides} JSONB into a fully typed {@link com.gearline.marketplace.common.dto.PublishListingRequest}.
 *   2. That request is passed to the marketplace connector, whose mapper translates
 *      it to the marketplace-specific API payload.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class SyncDispatcherService {

    private final MarketplaceConnectorRegistry connectorRegistry;
    private final MarketplaceAccountRepository accountRepository;
    private final MarketplaceListingRepository listingRepository;
    private final ProductRepository productRepository;
    private final InventoryConsistencyService inventoryConsistencyService;
    private final ListingAttributeResolver listingAttributeResolver;
    private final OrderImportService orderImportService;

    @Transactional
    public void dispatch(SyncJob job) {
        switch (job.getJobType()) {
            case LISTING_PUBLISH -> publishListing(job);
            case LISTING_UPDATE -> updateListing(job);
            case LISTING_DELIST -> delistListing(job);
            case INVENTORY_SYNC -> syncInventory(job);
            case ORDER_IMPORT -> importOrder(job);
            default -> log.warn("No handler for sync job type: {}", job.getJobType());
        }
    }

    private void publishListing(SyncJob job) {
        MarketplaceAccount account = requireAccount(job.getMarketplaceAccountId());
        Product product = requireProduct(job.getProductId());
        MarketplaceConnector connector = connectorRegistry.getConnector(job.getMarketplaceType());

        // Find or create a transient listing shell so the resolver can read existing overrides.
        // For brand-new listings the shell has empty overrides; all attributes fall back to product defaults.
        MarketplaceListing listing = listingRepository
            .findByProductIdAndMarketplaceAccountId(product.getId(), account.getId())
            .orElse(MarketplaceListing.builder()
                .productId(product.getId())
                .marketplaceAccountId(account.getId())
                .marketplaceType(job.getMarketplaceType())
                .build());

        // Resolve: product defaults → listing_overrides → typed PublishListingRequest
        PublishListingRequest request = listingAttributeResolver.resolve(product, listing);

        PublishListingResult result = connector.publishListing(account, product, request);

        if (result.isSuccess()) {
            listing.setExternalListingId(result.getExternalListingId());
            listing.setListingStatus(ListingStatus.ACTIVE);
            listing.setSyncedPrice(result.getPublishedPrice());
            listing.setSyncedQuantity(result.getPublishedQuantity());
            listing.setLastSyncAt(Instant.now());
            listing.setLastError(null);
            // Merge insurance value into metadata so it's auditable in the UI
            Map<String, Object> metadata = new HashMap<>(
                result.getRawMetadata() != null ? result.getRawMetadata() : Map.of());
            if (request.getShippingDetails() != null
                    && request.getShippingDetails().getInsuranceValueUsd() != null) {
                metadata.put("insurance_value_usd",
                    request.getShippingDetails().getInsuranceValueUsd().toPlainString());
            }
            listing.setMarketplaceMetadata(metadata);
        } else {
            listing.setListingStatus(ListingStatus.FAILED);
            listing.setLastError(result.getErrorMessage());
            listing.setErrorCount(listing.getErrorCount() + 1);
        }

        listingRepository.save(listing);
    }

    private void updateListing(SyncJob job) {
        MarketplaceAccount account = requireAccount(job.getMarketplaceAccountId());
        Product product = requireProduct(job.getProductId());
        MarketplaceListing listing = requireListing(job.getListingId());
        MarketplaceConnector connector = connectorRegistry.getConnector(job.getMarketplaceType());

        // Re-resolve attributes on every update so any changes to listing_overrides
        // (e.g. a newly set reverb_shipping_profile_name) are picked up automatically.
        PublishListingRequest request = listingAttributeResolver.resolve(product, listing);

        PublishListingResult result = connector.updateListing(account, product, listing, request);

        if (result.isSuccess()) {
            listing.setListingStatus(ListingStatus.ACTIVE);
            listing.setSyncedPrice(result.getPublishedPrice());
            listing.setSyncedQuantity(result.getPublishedQuantity());
            listing.setLastSyncAt(Instant.now());
            listing.setLastError(null);
        } else {
            listing.setListingStatus(ListingStatus.FAILED);
            listing.setLastError(result.getErrorMessage());
            listing.setErrorCount(listing.getErrorCount() + 1);
        }

        listingRepository.save(listing);
    }

    private void delistListing(SyncJob job) {
        MarketplaceAccount account = requireAccount(job.getMarketplaceAccountId());
        MarketplaceListing listing = requireListing(job.getListingId());
        MarketplaceConnector connector = connectorRegistry.getConnector(job.getMarketplaceType());

        connector.delistListing(account, listing);
        listing.setListingStatus(ListingStatus.DELISTED);
        listing.setLastSyncAt(Instant.now());
        listingRepository.save(listing);
    }

    private void syncInventory(SyncJob job) {
        MarketplaceAccount account = requireAccount(job.getMarketplaceAccountId());
        MarketplaceListing listing = requireListing(job.getListingId());
        Product product = requireProduct(job.getProductId());
        MarketplaceConnector connector = connectorRegistry.getConnector(job.getMarketplaceType());

        InventorySyncResult result = connector.syncInventory(account, listing, product.getQuantity());

        if (result.isSuccess()) {
            listing.setSyncedQuantity(result.getQuantitySynced());
            listing.setLastSyncAt(Instant.now());
            listing.setLastError(null);
        } else {
            listing.setLastError(result.getErrorMessage());
            listing.setErrorCount(listing.getErrorCount() + 1);
        }

        listingRepository.save(listing);
    }

    private void importOrder(SyncJob job) {
        MarketplaceAccount account = requireAccount(job.getMarketplaceAccountId());
        MarketplaceConnector connector = connectorRegistry.getConnector(job.getMarketplaceType());

        String externalOrderId = (String) job.getPayload().get("externalOrderId");
        ImportedOrder importedOrder = connector.importOrder(account, externalOrderId);

        // Full pipeline: save → inventory deduction → Shopify push
        orderImportService.importOrder(importedOrder, account);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private MarketplaceAccount requireAccount(UUID id) {
        return accountRepository.findById(id)
            .orElseThrow(() -> new IllegalArgumentException("MarketplaceAccount not found: " + id));
    }

    private Product requireProduct(UUID id) {
        return productRepository.findById(id)
            .orElseThrow(() -> new IllegalArgumentException("Product not found: " + id));
    }

    private MarketplaceListing requireListing(UUID id) {
        return listingRepository.findById(id)
            .orElseThrow(() -> new IllegalArgumentException("MarketplaceListing not found: " + id));
    }
}
