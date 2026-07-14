package com.gearline.infrastructure.messaging;

import com.gearline.domain.audit.AuditEventType;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobStatus;
import com.gearline.infrastructure.persistence.SyncJobRepository;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.service.AuditService;
import com.gearline.service.SyncDispatcherService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.AmqpRejectAndDontRequeueException;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Map;

/**
 * Consumes sync job messages from RabbitMQ.
 *
 * ── Transaction design ───────────────────────────────────────────────────────
 *
 * consume() is intentionally NOT @Transactional. This is critical.
 *
 * If consume() held an outer transaction while calling dispatch(), any unchecked
 * exception from dispatch() would mark that transaction rollback-only BEFORE
 * reaching the catch block. All subsequent DB saves in the catch block (updating
 * retryCount, dead-lettering the job) would silently roll back — even though
 * the RabbitMQ message was already published (non-XA). The result is an infinite
 * retry loop where retryCount never persists.
 *
 * Without @Transactional on consume():
 *   1. dispatch() runs in its own transaction (REQUIRED propagation). If it
 *      throws, that transaction rolls back — but consume() is unaffected.
 *   2. The catch block runs with NO active transaction.
 *   3. Status/retryCount saves each open their own short transaction and commit.
 *   4. RabbitMQ message scheduling (for retry) happens only after those commits.
 *
 * ── Retry flow ────────────────────────────────────────────────────────────────
 *
 * On failure the job is marked FAILED with a nextRetryAt timestamp. A separate
 * SyncJobRetryScheduler polls for FAILED jobs whose nextRetryAt has elapsed and
 * re-enqueues them. This provides true exponential backoff without needing a
 * delayed-message RabbitMQ plugin.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class SyncJobConsumer {

    private final SyncJobRepository syncJobRepository;
    private final SyncDispatcherService syncDispatcherService;
    private final SyncJobProducer syncJobProducer;
    private final AuditService auditService;

    @RabbitListener(queues = "#{@syncJobQueue.name}", containerFactory = "rabbitListenerContainerFactory")
    // NOTE: No @Transactional here — see class-level Javadoc for the reason.
    public void consume(SyncJobMessage message) {
        log.info("Processing sync job {} type={} marketplace={} attempt={}",
            message.getSyncJobId(), message.getJobType(), message.getMarketplaceType(), message.getAttemptNumber());

        SyncJob job = syncJobRepository.findById(message.getSyncJobId()).orElse(null);
        if (job == null) {
            log.warn("Sync job {} not found in database — skipping", message.getSyncJobId());
            return;
        }

        if (job.getStatus() == SyncJobStatus.CANCELLED || job.getStatus() == SyncJobStatus.COMPLETED) {
            log.debug("Sync job {} is {} — skipping", job.getId(), job.getStatus());
            return;
        }

        // Mark IN_PROGRESS in its own transaction so it commits immediately
        markInProgress(job);

        auditService.recordMarketplaceEvent(
            AuditEventType.SYNC_JOB_STARTED, job.getMarketplaceType(), null,
            "SyncJob", job.getId().toString(), true, null, Map.of("jobType", job.getJobType())
        );

        try {
            // dispatch() runs in its own @Transactional(REQUIRED) transaction.
            // If it throws, that transaction rolls back but this catch block still executes.
            syncDispatcherService.dispatch(job);

            // Success: mark COMPLETED in its own transaction
            markCompleted(job);

            auditService.recordMarketplaceEvent(
                AuditEventType.SYNC_JOB_COMPLETED, job.getMarketplaceType(), null,
                "SyncJob", job.getId().toString(), true, null, Map.of("jobType", job.getJobType())
            );

        } catch (Exception e) {
            log.error("Sync job {} failed on attempt {}: {}", job.getId(), message.getAttemptNumber(), e.getMessage(), e);

            // Reload the job from DB to get the true persisted retryCount.
            // (The in-memory `job` object still has whatever retryCount was before dispatch ran.)
            job = syncJobRepository.findById(job.getId()).orElse(job);
            job.setFailureReason(e.getMessage());

            if (job.getRetryCount() < job.getMaxRetries()) {
                // Schedule retry with exponential backoff: mark FAILED + set nextRetryAt.
                // SyncJobRetryScheduler will pick this up when nextRetryAt has elapsed and
                // re-enqueue to RabbitMQ. This avoids immediate re-delivery and provides
                // true backoff without needing a delayed-message exchange.
                syncJobProducer.scheduleRetry(job);
            } else {
                // Exhausted retries — dead-letter the job in its own transaction
                markDeadLettered(job);

                // Finding #22: if a LISTING_DELIST job is dead-lettered, mark the
                // listing as FAILED so the operator knows manual action is required.
                if (job.getJobType() == SyncJobType.LISTING_DELIST) {
                    syncDispatcherService.markDelistFailed(job);
                }

                auditService.recordMarketplaceEvent(
                    AuditEventType.SYNC_JOB_DEAD_LETTERED, job.getMarketplaceType(), null,
                    "SyncJob", job.getId().toString(), false, e.getMessage(), Map.of()
                );

                // Reject without requeue — RabbitMQ will route to DLX
                throw new AmqpRejectAndDontRequeueException("Job exhausted retries: " + job.getId(), e);
            }
        }
    }

    // ── Private helpers — each commits in its own short transaction ───────────

    @Transactional
    protected void markInProgress(SyncJob job) {
        job.setStatus(SyncJobStatus.IN_PROGRESS);
        job.setStartedAt(Instant.now());
        syncJobRepository.save(job);
    }

    @Transactional
    protected void markCompleted(SyncJob job) {
        job.setStatus(SyncJobStatus.COMPLETED);
        job.setCompletedAt(Instant.now());
        syncJobRepository.save(job);
    }

    @Transactional
    protected void markDeadLettered(SyncJob job) {
        job.setStatus(SyncJobStatus.DEAD_LETTERED);
        syncJobRepository.save(job);
    }
}
