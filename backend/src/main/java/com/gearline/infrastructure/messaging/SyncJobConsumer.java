package com.gearline.infrastructure.messaging;

import com.gearline.domain.audit.AuditEventType;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobStatus;
import com.gearline.infrastructure.persistence.SyncJobRepository;
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

@Component
@RequiredArgsConstructor
@Slf4j
public class SyncJobConsumer {

    private final SyncJobRepository syncJobRepository;
    private final SyncDispatcherService syncDispatcherService;
    private final SyncJobProducer syncJobProducer;
    private final AuditService auditService;

    @RabbitListener(queues = "#{@syncJobQueue.name}", containerFactory = "rabbitListenerContainerFactory")
    @Transactional
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

        job.setStatus(SyncJobStatus.IN_PROGRESS);
        job.setStartedAt(Instant.now());
        syncJobRepository.save(job);

        auditService.recordMarketplaceEvent(
            AuditEventType.SYNC_JOB_STARTED, job.getMarketplaceType(), null,
            "SyncJob", job.getId().toString(), true, null, Map.of("jobType", job.getJobType())
        );

        try {
            syncDispatcherService.dispatch(job);

            job.setStatus(SyncJobStatus.COMPLETED);
            job.setCompletedAt(Instant.now());
            syncJobRepository.save(job);

            auditService.recordMarketplaceEvent(
                AuditEventType.SYNC_JOB_COMPLETED, job.getMarketplaceType(), null,
                "SyncJob", job.getId().toString(), true, null, Map.of("jobType", job.getJobType())
            );

        } catch (Exception e) {
            log.error("Sync job {} failed on attempt {}: {}", job.getId(), message.getAttemptNumber(), e.getMessage(), e);

            job.setFailureReason(e.getMessage());

            if (job.getRetryCount() < job.getMaxRetries()) {
                // Retry with exponential backoff
                syncJobProducer.requeueForRetry(job);
            } else {
                // Exhausted retries — send to dead letter queue
                job.setStatus(SyncJobStatus.DEAD_LETTERED);
                syncJobRepository.save(job);

                auditService.recordMarketplaceEvent(
                    AuditEventType.SYNC_JOB_DEAD_LETTERED, job.getMarketplaceType(), null,
                    "SyncJob", job.getId().toString(), false, e.getMessage(), Map.of()
                );

                // Reject without requeue — RabbitMQ will route to DLX
                throw new AmqpRejectAndDontRequeueException("Job exhausted retries: " + job.getId(), e);
            }
        }
    }
}
