package com.gearline.infrastructure.messaging;

import com.gearline.domain.sync.SyncJobType;
import com.gearline.marketplace.common.connector.MarketplaceType;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * The message payload placed on the RabbitMQ sync queue.
 * Serialized as JSON. Contains enough context to process the job
 * without requiring additional DB lookups for routing decisions.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SyncJobMessage {

    private UUID syncJobId;
    private SyncJobType jobType;
    private MarketplaceType marketplaceType;
    private UUID marketplaceAccountId;
    private UUID productId;
    private UUID listingId;
    private int attemptNumber;
    private Instant enqueuedAt;
    private Map<String, Object> payload;
}
