package com.gearline.api.admin;

import com.gearline.infrastructure.persistence.*;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/admin/dashboard")
@RequiredArgsConstructor
@Tag(name = "Dashboard", description = "Operational health and metrics")
public class DashboardController {

    private final ProductRepository productRepository;
    private final MarketplaceListingRepository listingRepository;
    private final OrderRepository orderRepository;
    private final SyncJobRepository syncJobRepository;
    private final MarketplaceAccountRepository accountRepository;

    @GetMapping("/stats")
    @Operation(summary = "Get dashboard operational statistics")
    public ResponseEntity<DashboardStatsDto> getStats() {
        DashboardStatsDto stats = DashboardStatsDto.builder()
            .totalProducts(productRepository.count())
            .activeListings(listingRepository.countActiveListings())
            .failedListings(listingRepository.countFailedListings())
            .pendingReviewListings(listingRepository.countNeedsReviewListings())
            .totalOrders(orderRepository.count())
            .failedSyncJobs(syncJobRepository.countFailedJobs())
            .inProgressSyncJobs(syncJobRepository.countInProgressJobs())
            .connectedAccounts(accountRepository.findByActiveTrue().size())
            .build();

        return ResponseEntity.ok(stats);
    }
}
