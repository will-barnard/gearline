package com.gearline.infrastructure.messaging;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobStatus;
import com.gearline.infrastructure.persistence.SyncJobRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;

@Service
@RequiredArgsConstructor
@Slf4j
public class SyncJobProducer {

    private final RabbitTemplate rabbitTemplate;
    private final SyncJobRepository syncJobRepository;
    private final GearlineProperties properties;

    /**
     * Enqueues a sync job: persists it to the database, then publishes to RabbitMQ
     * <em>after</em> the transaction commits.
     *
     * ── Why afterCommit? (Finding #15) ────────────────────────────────────────
     *
     * RabbitMQ is not transactional with the database (non-XA). If we publish
     * inside the same transaction, the message is sent immediately — before the
     * DB row is committed. Should the transaction roll back, the consumer would
     * receive a message for a job that doesn't exist in the DB.
     *
     * By using {@link TransactionSynchronizationManager#registerSynchronization}
     * we delay the publish until after the DB commit is confirmed.
     */
    @Transactional
    public SyncJob enqueue(SyncJob job) {
        job.setStatus(SyncJobStatus.QUEUED);
        SyncJob saved = syncJobRepository.save(job);

        SyncJobMessage message = SyncJobMessage.builder()
            .syncJobId(saved.getId())
            .jobType(saved.getJobType())
            .marketplaceType(saved.getMarketplaceType())
            .marketplaceAccountId(saved.getMarketplaceAccountId())
            .productId(saved.getProductId())
            .listingId(saved.getListingId())
            .attemptNumber(1)
            .enqueuedAt(Instant.now())
            .payload(saved.getPayload())
            .build();

        String routingKey = buildRoutingKey(saved);

        // Publish AFTER commit so the consumer never sees a job that doesn't exist in DB.
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    rabbitTemplate.convertAndSend(
                        properties.getQueue().getSyncExchange(),
                        routingKey,
                        message
                    );
                    log.info("Published sync job {} to queue after DB commit", saved.getId());
                }
            });
        } else {
            // No active transaction (e.g. test or scheduler context): publish immediately.
            rabbitTemplate.convertAndSend(
                properties.getQueue().getSyncExchange(),
                routingKey,
                message
            );
        }

        log.info("Enqueued sync job {} of type {} for marketplace {}",
            saved.getId(), saved.getJobType(), saved.getMarketplaceType());

        return saved;
    }

    /**
     * Marks a failed job for retry with exponential backoff — does NOT publish to RabbitMQ.
     *
     * ── Why no immediate publish? (Findings #8, #9) ───────────────────────────
     *
     * The previous design published immediately with a {@code nextRetryAt} timestamp
     * that was purely advisory — the consumer received the message right away with
     * no delay, making exponential backoff ineffective.
     *
     * New flow:
     *   1. This method marks the job FAILED and sets nextRetryAt. No RabbitMQ message.
     *   2. {@link SyncJobRetryScheduler} polls every 60 s for FAILED jobs whose
     *      nextRetryAt has elapsed and calls {@link #publishRetry(SyncJob)}.
     *
     * This provides true exponential backoff without a delayed-message exchange plugin.
     */
    @Transactional
    public void scheduleRetry(SyncJob job) {
        int attempt = job.getRetryCount() + 1;
        long delayMs = calculateBackoffDelay(attempt);

        job.setRetryCount(attempt);
        job.setNextRetryAt(Instant.now().plusMillis(delayMs));
        job.setStatus(SyncJobStatus.FAILED);
        syncJobRepository.save(job);

        log.info("Scheduled retry for sync job {} attempt {}/{} in {}ms",
            job.getId(), attempt, job.getMaxRetries(), delayMs);
    }

    /**
     * Re-publishes a FAILED job to RabbitMQ after its backoff window has elapsed.
     * Called by {@link SyncJobRetryScheduler} — not by the consumer directly.
     */
    @Transactional
    public void publishRetry(SyncJob job) {
        job.setStatus(SyncJobStatus.QUEUED);
        SyncJob saved = syncJobRepository.save(job);

        SyncJobMessage message = SyncJobMessage.builder()
            .syncJobId(saved.getId())
            .jobType(saved.getJobType())
            .marketplaceType(saved.getMarketplaceType())
            .marketplaceAccountId(saved.getMarketplaceAccountId())
            .productId(saved.getProductId())
            .listingId(saved.getListingId())
            .attemptNumber(saved.getRetryCount())
            .enqueuedAt(Instant.now())
            .payload(saved.getPayload())
            .build();

        String routingKey = buildRoutingKey(saved);

        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    rabbitTemplate.convertAndSend(
                        properties.getQueue().getSyncExchange(),
                        routingKey,
                        message
                    );
                    log.info("Re-published retry for sync job {} (attempt {})",
                        saved.getId(), saved.getRetryCount());
                }
            });
        } else {
            rabbitTemplate.convertAndSend(
                properties.getQueue().getSyncExchange(),
                routingKey,
                message
            );
        }
    }

    private long calculateBackoffDelay(int attempt) {
        long initial = properties.getSync().getInitialRetryDelayMs();
        long max = properties.getSync().getMaxRetryDelayMs();
        long delay = (long) (initial * Math.pow(2, attempt - 1));
        return Math.min(delay, max);
    }

    private String buildRoutingKey(SyncJob job) {
        String marketplace = job.getMarketplaceType() != null ? job.getMarketplaceType().name().toLowerCase() : "any";
        return "sync." + marketplace + "." + job.getJobType().name().toLowerCase();
    }
}
