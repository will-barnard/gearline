package com.gearline.api.admin;

import lombok.Builder;
import lombok.Value;

@Value
@Builder
public class DashboardStatsDto {
    long totalProducts;
    long activeListings;
    long failedListings;
    /** Listings in NEEDS_REVIEW status — awaiting user approval before publishing */
    long pendingReviewListings;
    long totalOrders;
    long failedSyncJobs;
    long inProgressSyncJobs;
    long connectedAccounts;
}
