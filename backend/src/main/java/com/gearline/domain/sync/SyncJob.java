package com.gearline.domain.sync;

import com.gearline.domain.audit.AuditableEntity;
import com.gearline.marketplace.common.connector.MarketplaceType;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "sync_jobs", indexes = {
    @Index(name = "idx_sync_jobs_status", columnList = "status"),
    @Index(name = "idx_sync_jobs_job_type", columnList = "job_type"),
    @Index(name = "idx_sync_jobs_account_id", columnList = "marketplace_account_id"),
    @Index(name = "idx_sync_jobs_product_id", columnList = "product_id"),
    @Index(name = "idx_sync_jobs_created_at", columnList = "created_at")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
@EqualsAndHashCode(of = "id", callSuper = false)
public class SyncJob extends AuditableEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Enumerated(EnumType.STRING)
    @Column(name = "job_type", nullable = false, length = 50)
    private SyncJobType jobType;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    @Builder.Default
    private SyncJobStatus status = SyncJobStatus.QUEUED;

    @Enumerated(EnumType.STRING)
    @Column(name = "marketplace_type", length = 30)
    private MarketplaceType marketplaceType;

    @Column(name = "marketplace_account_id")
    private UUID marketplaceAccountId;

    @Column(name = "product_id")
    private UUID productId;

    @Column(name = "listing_id")
    private UUID listingId;

    @Column(name = "retry_count", nullable = false)
    @Builder.Default
    private Integer retryCount = 0;

    @Column(name = "max_retries", nullable = false)
    @Builder.Default
    private Integer maxRetries = 5;

    @Column(name = "next_retry_at")
    private Instant nextRetryAt;

    /**
     * Structured payload for this job (product IDs, listing IDs, etc.)
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    @Builder.Default
    private Map<String, Object> payload = new HashMap<>();

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    @Column(name = "failure_reason", columnDefinition = "TEXT")
    private String failureReason;

    /** Idempotency key — prevents duplicate processing of the same event */
    @Column(name = "idempotency_key", unique = true, length = 200)
    private String idempotencyKey;
}
