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

import java.time.Instant;

@Service
@RequiredArgsConstructor
@Slf4j
public class SyncJobProducer {

    private final RabbitTemplate rabbitTemplate;
    private final SyncJobRepository syncJobRepository;
    private final GearlineProperties properties;

    /**
     * Enqueues a sync job: persists it to the database, then publishes to RabbitMQ.
     * The DB record is committed first so that the job is visible to monitoring even
     * if RabbitMQ is temporarily unavailable (scheduler will retry).
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
        rabbitTemplate.convertAndSend(
            properties.getQueue().getSyncExchange(),
            routingKey,
            message
        );

        log.info("Enqueued sync job {} of type {} for marketplace {}",
            saved.getId(), saved.getJobType(), saved.getMarketplaceType());

        return saved;
    }

    /**
     * Re-queues a failed job for retry. Updates retry count and next retry time.
     */
    @Transactional
    public void requeueForRetry(SyncJob job) {
        int attempt = job.getRetryCount() + 1;
        long delayMs = calculateBackoffDelay(attempt);

        job.setRetryCount(attempt);
        job.setNextRetryAt(Instant.now().plusMillis(delayMs));
        job.setStatus(SyncJobStatus.QUEUED);
        syncJobRepository.save(job);

        SyncJobMessage message = SyncJobMessage.builder()
            .syncJobId(job.getId())
            .jobType(job.getJobType())
            .marketplaceType(job.getMarketplaceType())
            .marketplaceAccountId(job.getMarketplaceAccountId())
            .productId(job.getProductId())
            .listingId(job.getListingId())
            .attemptNumber(attempt)
            .enqueuedAt(Instant.now())
            .payload(job.getPayload())
            .build();

        rabbitTemplate.convertAndSend(
            properties.getQueue().getSyncExchange(),
            buildRoutingKey(job),
            message
        );

        log.info("Requeued sync job {} attempt {}/{} with {}ms delay",
            job.getId(), attempt, job.getMaxRetries(), delayMs);
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
