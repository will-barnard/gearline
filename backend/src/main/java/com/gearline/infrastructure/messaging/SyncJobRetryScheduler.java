package com.gearline.infrastructure.messaging;

import com.gearline.domain.sync.SyncJob;
import com.gearline.infrastructure.persistence.SyncJobRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Polls the database for FAILED sync jobs whose retry window has elapsed and
 * re-enqueues them to RabbitMQ.
 *
 * ── Why a scheduler rather than immediate re-queue? ──────────────────────────
 *
 * {@link SyncJobProducer#scheduleRetry} marks failed jobs as FAILED with a
 * {@code nextRetryAt} timestamp set to now + exponential backoff delay. It does
 * NOT publish to RabbitMQ. This scheduler picks them up once the delay has passed.
 *
 * This gives us true exponential backoff without a delayed-message RabbitMQ
 * exchange plugin, and without the infinite-retry loop that occurred when retry
 * state was saved inside a doomed rollback-only transaction.
 *
 * ── Finding #21 fix ──────────────────────────────────────────────────────────
 *
 * {@link SyncJobRepository#findJobsDueForRetry} queries for {@code status = FAILED}
 * which matches exactly what {@link SyncJobProducer#scheduleRetry} sets.
 * Previously no code ever set FAILED status so the query always returned nothing.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class SyncJobRetryScheduler {

    private final SyncJobRepository syncJobRepository;
    private final SyncJobProducer syncJobProducer;

    @Scheduled(
        fixedDelayString  = "${gearline.sync.retry-poll-interval-ms:60000}",
        initialDelayString = "${gearline.sync.retry-poll-initial-delay-ms:30000}",
        timeUnit = TimeUnit.MILLISECONDS
    )
    public void retryDueJobs() {
        List<SyncJob> due = syncJobRepository.findJobsDueForRetry(Instant.now());
        if (due.isEmpty()) return;

        log.info("Retry scheduler: {} FAILED job(s) due for re-enqueue", due.size());

        for (SyncJob job : due) {
            try {
                syncJobProducer.publishRetry(job);
                log.info("Re-enqueued sync job {} (attempt {}/{})",
                    job.getId(), job.getRetryCount(), job.getMaxRetries());
            } catch (Exception e) {
                log.error("Failed to re-enqueue sync job {}: {}", job.getId(), e.getMessage(), e);
            }
        }
    }
}
