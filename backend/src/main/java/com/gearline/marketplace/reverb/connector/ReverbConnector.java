package com.gearline.marketplace.reverb.connector;

import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Product;
import com.gearline.marketplace.common.connector.*;
import com.gearline.marketplace.common.dto.*;
import com.gearline.marketplace.reverb.client.ReverbApiClient;
import com.gearline.marketplace.reverb.client.ReverbApiException;
import com.gearline.marketplace.reverb.dto.ReverbListingDto;
import com.gearline.marketplace.reverb.dto.ReverbOrderDto;
import com.gearline.marketplace.reverb.mapper.ReverbListingMapper;
import com.gearline.marketplace.reverb.mapper.ReverbOrderMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Reverb marketplace connector — the reference implementation.
 *
 * All Reverb-specific logic is isolated here and in the reverb.* packages.
 * The core domain never directly references this class.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ReverbConnector implements MarketplaceConnector {

    private final ReverbApiClient apiClient;
    private final ReverbListingMapper listingMapper;
    private final ReverbOrderMapper orderMapper;
    private final ReverbAuthProvider authProvider;

    @Override
    public MarketplaceType getMarketplaceType() {
        return MarketplaceType.REVERB;
    }

    @Override
    public MarketplaceAuthProvider getAuthProvider() {
        return authProvider;
    }

    // ── ListingPublisher ───────────────────────────────────────────────────────

    @Override
    public PublishListingResult publishListing(
        MarketplaceAccount account,
        Product product,
        PublishListingRequest request
    ) {
        log.info("Publishing listing to Reverb for product {} (sku={})", product.getId(), product.getSku());

        ensureValidToken(account);
        Map<String, Object> body = listingMapper.toReverbRequest(product, request);

        try {
            ReverbListingDto result = apiClient.createListing(account, body);

            BigDecimal price = extractPrice(result);
            Map<String, Object> metadata = buildMetadata(result);

            log.info("Successfully published Reverb listing {} for product {}", result.getId(), product.getSku());

            return PublishListingResult.success(
                result.getId(),
                price,
                request.getQuantity(),
                metadata
            );

        } catch (ReverbApiException e) {
            log.error("Failed to publish listing to Reverb for product {}: {}", product.getSku(), e.getMessage());
            return PublishListingResult.failure(e.getMessage());
        }
    }

    @Override
    public PublishListingResult updateListing(
        MarketplaceAccount account,
        Product product,
        MarketplaceListing existingListing,
        PublishListingRequest request
    ) {
        log.info("Updating Reverb listing {} for product {}", existingListing.getExternalListingId(), product.getSku());

        ensureValidToken(account);
        Map<String, Object> body = listingMapper.toReverbRequest(product, request);

        try {
            ReverbListingDto result = apiClient.updateListing(account, existingListing.getExternalListingId(), body);

            return PublishListingResult.success(
                result.getId(),
                extractPrice(result),
                request.getQuantity(),
                buildMetadata(result)
            );

        } catch (ReverbApiException e) {
            log.error("Failed to update Reverb listing {}: {}", existingListing.getExternalListingId(), e.getMessage());
            return PublishListingResult.failure(e.getMessage());
        }
    }

    @Override
    public void delistListing(MarketplaceAccount account, MarketplaceListing listing) {
        log.info("Delisting Reverb listing {}", listing.getExternalListingId());
        ensureValidToken(account);

        try {
            apiClient.endListing(account, listing.getExternalListingId());
            log.info("Successfully delisted Reverb listing {}", listing.getExternalListingId());
        } catch (ReverbApiException e) {
            log.error("Failed to delist Reverb listing {}: {}", listing.getExternalListingId(), e.getMessage());
            throw e;
        }
    }

    // ── InventorySynchronizer ──────────────────────────────────────────────────

    @Override
    public InventorySyncResult syncInventory(
        MarketplaceAccount account,
        MarketplaceListing listing,
        int newQuantity
    ) {
        log.info("Syncing Reverb inventory for listing {} to qty={}", listing.getExternalListingId(), newQuantity);
        ensureValidToken(account);

        try {
            apiClient.updateInventory(account, listing.getExternalListingId(), newQuantity);
            log.info("Successfully synced Reverb inventory for listing {}", listing.getExternalListingId());
            return InventorySyncResult.success(newQuantity);
        } catch (ReverbApiException e) {
            log.error("Failed to sync Reverb inventory for listing {}: {}", listing.getExternalListingId(), e.getMessage());
            return InventorySyncResult.failure(e.getMessage());
        }
    }

    // ── OrderImporter ──────────────────────────────────────────────────────────

    /**
     * Imports all Reverb orders created after {@code since}, paginating through all
     * pages (50 orders/page).
     *
     * Finding #2 fix: the previous implementation hardcoded page=1, silently dropping
     * any orders beyond the first 50. Now we loop until getOrders() returns fewer than
     * per_page results (indicating the last page).
     */
    @Override
    public List<ImportedOrder> importOrders(MarketplaceAccount account, Instant since) {
        log.info("Importing Reverb orders since {}", since);
        ensureValidToken(account);

        String sinceStr = since != null
            ? since.toString()
            : Instant.now().minusSeconds(86400).toString();

        List<ReverbOrderDto> allDtos = new ArrayList<>();
        int page = 1;
        final int PER_PAGE = 50;

        try {
            while (true) {
                List<ReverbOrderDto> dtos = apiClient.getOrders(account, sinceStr, page);
                if (dtos == null || dtos.isEmpty()) break;
                allDtos.addAll(dtos);
                // Reverb returns up to per_page results; fewer means we're on the last page
                if (dtos.size() < PER_PAGE) break;
                page++;
            }
        } catch (ReverbApiException e) {
            log.error("Failed to import Reverb orders (page {}): {}", page, e.getMessage());
            throw e;
        }

        log.info("Fetched {} Reverb orders across {} page(s)", allDtos.size(), page);
        return allDtos.stream()
            .map(orderMapper::toImportedOrder)
            .collect(Collectors.toList());
    }

    /**
     * Imports a single Reverb order by ID.
     *
     * Finding #6 fix: added null check — getOrder() can return null when the order
     * is not found or the API returns an empty body.
     */
    @Override
    public ImportedOrder importOrder(MarketplaceAccount account, String externalOrderId) {
        ensureValidToken(account);
        ReverbOrderDto dto = apiClient.getOrder(account, externalOrderId);
        if (dto == null) {
            log.warn("Reverb getOrder returned null for orderId={} — order not found or empty response",
                externalOrderId);
            return null;
        }
        return orderMapper.toImportedOrder(dto);
    }

    // ── Health Check ──────────────────────────────────────────────────────────

    @Override
    public ConnectorHealthResult checkHealth(MarketplaceAccount account) {
        try {
            boolean valid = apiClient.verifyToken(account);
            return valid
                ? ConnectorHealthResult.healthy(MarketplaceType.REVERB)
                : ConnectorHealthResult.unhealthy(MarketplaceType.REVERB, "Token validation failed");
        } catch (Exception e) {
            return ConnectorHealthResult.unhealthy(MarketplaceType.REVERB, e.getMessage());
        }
    }

    // ── Private Helpers ────────────────────────────────────────────────────────

    private void ensureValidToken(MarketplaceAccount account) {
        if (!authProvider.areCredentialsValid(account)) {
            log.info("Reverb token expired for account {} — refreshing", account.getId());
            authProvider.refreshAccessToken(account);
        }
    }

    private BigDecimal extractPrice(ReverbListingDto dto) {
        if (dto.getPrice() != null && dto.getPrice().getAmount() != null) {
            try {
                return new BigDecimal(dto.getPrice().getAmount());
            } catch (NumberFormatException e) {
                log.warn("Could not parse Reverb listing price: {}", dto.getPrice().getAmount());
            }
        }
        return BigDecimal.ZERO;
    }

    private Map<String, Object> buildMetadata(ReverbListingDto dto) {
        Map<String, Object> meta = new java.util.LinkedHashMap<>();
        meta.put("reverb_id", dto.getId());
        meta.put("slug", dto.getSlug());
        if (dto.getLinks() != null) {
            if (dto.getLinks().getWeb() != null) {
                meta.put("listing_url", dto.getLinks().getWeb().getHref());
            }
            if (dto.getLinks().getManageUrl() != null) {
                meta.put("manage_url", dto.getLinks().getManageUrl().getHref());
            }
        }
        return meta;
    }
}
