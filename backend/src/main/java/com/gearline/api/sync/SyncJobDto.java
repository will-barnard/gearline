package com.gearline.api.sync;

import com.gearline.domain.sync.*;
import com.gearline.marketplace.common.connector.MarketplaceType;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

public record SyncJobDto(
    UUID id,
    SyncJobType jobType,
    SyncJobStatus status,
    MarketplaceType marketplaceType,
    UUID marketplaceAccountId,
    UUID productId,
    UUID listingId,
    int retryCount,
    int maxRetries,
    Instant nextRetryAt,
    Map<String, Object> payload,
    Instant startedAt,
    Instant completedAt,
    String failureReason,
    String idempotencyKey,
    Instant createdAt
) {
    public static SyncJobDto from(SyncJob j) {
        return new SyncJobDto(
            j.getId(), j.getJobType(), j.getStatus(), j.getMarketplaceType(),
            j.getMarketplaceAccountId(), j.getProductId(), j.getListingId(),
            j.getRetryCount(), j.getMaxRetries(), j.getNextRetryAt(),
            j.getPayload(), j.getStartedAt(), j.getCompletedAt(),
            j.getFailureReason(), j.getIdempotencyKey(), j.getCreatedAt()
        );
    }
}
