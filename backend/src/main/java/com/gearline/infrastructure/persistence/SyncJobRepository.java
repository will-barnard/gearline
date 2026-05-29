package com.gearline.infrastructure.persistence;

import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobStatus;
import com.gearline.domain.sync.SyncJobType;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface SyncJobRepository extends JpaRepository<SyncJob, UUID> {

    Optional<SyncJob> findByIdempotencyKey(String idempotencyKey);
    boolean existsByIdempotencyKey(String idempotencyKey);

    Page<SyncJob> findByStatus(SyncJobStatus status, Pageable pageable);
    Page<SyncJob> findByMarketplaceAccountId(UUID accountId, Pageable pageable);

    @Query("SELECT j FROM SyncJob j WHERE j.status = 'FAILED' AND j.nextRetryAt <= :now AND j.retryCount < j.maxRetries")
    List<SyncJob> findJobsDueForRetry(@Param("now") Instant now);

    @Query("SELECT COUNT(j) FROM SyncJob j WHERE j.status = 'FAILED'")
    long countFailedJobs();

    @Query("SELECT COUNT(j) FROM SyncJob j WHERE j.status = 'IN_PROGRESS'")
    long countInProgressJobs();
}
