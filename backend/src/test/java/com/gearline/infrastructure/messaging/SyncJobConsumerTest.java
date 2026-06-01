package com.gearline.infrastructure.messaging;

import com.gearline.domain.audit.AuditEventType;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobStatus;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.infrastructure.persistence.SyncJobRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.service.AuditService;
import com.gearline.service.SyncDispatcherService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.AmqpRejectAndDontRequeueException;

import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for SyncJobConsumer — job status transitions, retry logic,
 * dead-letter routing, and audit event recording.
 *
 * The @RabbitListener annotation is irrelevant here; consume() is called directly.
 */
class SyncJobConsumerTest {

    private SyncJobRepository syncJobRepository;
    private SyncDispatcherService syncDispatcherService;
    private SyncJobProducer syncJobProducer;
    private AuditService auditService;
    private SyncJobConsumer consumer;

    @BeforeEach
    void setUp() {
        syncJobRepository   = mock(SyncJobRepository.class);
        syncDispatcherService = mock(SyncDispatcherService.class);
        syncJobProducer     = mock(SyncJobProducer.class);
        auditService        = mock(AuditService.class);

        consumer = new SyncJobConsumer(
            syncJobRepository, syncDispatcherService, syncJobProducer, auditService
        );

        when(syncJobRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    // ── Happy path ─────────────────────────────────────────────────────────────

    @Test
    void consume_setsInProgress_thenCompleted_onSuccess() {
        SyncJob job = queuedJob(3, 5);
        when(syncJobRepository.findById(job.getId())).thenReturn(Optional.of(job));
        doNothing().when(syncDispatcherService).dispatch(any());

        consumer.consume(message(job));

        verify(syncJobRepository, atLeastOnce()).save(argThat(j ->
            j.getStatus() == SyncJobStatus.COMPLETED && j.getCompletedAt() != null
        ));
    }

    @Test
    void consume_recordsStartedAndCompletedAuditEvents_onSuccess() {
        SyncJob job = queuedJob(0, 3);
        when(syncJobRepository.findById(job.getId())).thenReturn(Optional.of(job));

        consumer.consume(message(job));

        verify(auditService).recordMarketplaceEvent(
            eq(AuditEventType.SYNC_JOB_STARTED), any(), any(), any(), any(), anyBoolean(), any(), any()
        );
        verify(auditService).recordMarketplaceEvent(
            eq(AuditEventType.SYNC_JOB_COMPLETED), any(), any(), any(), any(), anyBoolean(), any(), any()
        );
    }

    // ── Job not found ──────────────────────────────────────────────────────────

    @Test
    void consume_doesNothing_whenJobNotInDatabase() {
        UUID jobId = UUID.randomUUID();
        when(syncJobRepository.findById(jobId)).thenReturn(Optional.empty());

        consumer.consume(message(jobId));

        verify(syncDispatcherService, never()).dispatch(any());
        verify(syncJobRepository, never()).save(any());
    }

    // ── Already-terminal jobs ──────────────────────────────────────────────────

    @Test
    void consume_skipsDispatch_whenJobAlreadyCompleted() {
        SyncJob job = jobWithStatus(SyncJobStatus.COMPLETED, 0, 3);
        when(syncJobRepository.findById(job.getId())).thenReturn(Optional.of(job));

        consumer.consume(message(job));

        verify(syncDispatcherService, never()).dispatch(any());
    }

    @Test
    void consume_skipsDispatch_whenJobCancelled() {
        SyncJob job = jobWithStatus(SyncJobStatus.CANCELLED, 0, 3);
        when(syncJobRepository.findById(job.getId())).thenReturn(Optional.of(job));

        consumer.consume(message(job));

        verify(syncDispatcherService, never()).dispatch(any());
    }

    // ── Retry path ─────────────────────────────────────────────────────────────

    @Test
    void consume_requeuesForRetry_whenDispatchFailsAndRetriesRemain() {
        SyncJob job = queuedJob(2, 5);  // retryCount=2, maxRetries=5 — retries remain
        when(syncJobRepository.findById(job.getId())).thenReturn(Optional.of(job));
        doThrow(new RuntimeException("Network error")).when(syncDispatcherService).dispatch(any());

        consumer.consume(message(job));

        verify(syncJobProducer).requeueForRetry(job);
        verify(syncJobRepository, never()).save(argThat(j ->
            j.getStatus() == SyncJobStatus.DEAD_LETTERED
        ));
    }

    @Test
    void consume_setsFailureReason_onDispatchException() {
        SyncJob job = queuedJob(0, 5);
        when(syncJobRepository.findById(job.getId())).thenReturn(Optional.of(job));
        doThrow(new RuntimeException("Connector timeout")).when(syncDispatcherService).dispatch(any());

        consumer.consume(message(job));

        verify(syncJobRepository).save(argThat(j ->
            "Connector timeout".equals(j.getFailureReason())
        ));
    }

    // ── Dead-letter path ───────────────────────────────────────────────────────

    @Test
    void consume_deadLettersJob_whenRetriesExhausted() {
        SyncJob job = queuedJob(5, 5);  // retryCount == maxRetries
        when(syncJobRepository.findById(job.getId())).thenReturn(Optional.of(job));
        doThrow(new RuntimeException("Permanent failure")).when(syncDispatcherService).dispatch(any());

        assertThatThrownBy(() -> consumer.consume(message(job)))
            .isInstanceOf(AmqpRejectAndDontRequeueException.class);

        verify(syncJobRepository).save(argThat(j ->
            j.getStatus() == SyncJobStatus.DEAD_LETTERED
        ));
    }

    @Test
    void consume_recordsDeadLetteredAuditEvent_whenRetriesExhausted() {
        SyncJob job = queuedJob(5, 5);
        when(syncJobRepository.findById(job.getId())).thenReturn(Optional.of(job));
        doThrow(new RuntimeException("Permanent failure")).when(syncDispatcherService).dispatch(any());

        assertThatThrownBy(() -> consumer.consume(message(job)))
            .isInstanceOf(AmqpRejectAndDontRequeueException.class);

        verify(auditService).recordMarketplaceEvent(
            eq(AuditEventType.SYNC_JOB_DEAD_LETTERED), any(), any(), any(), any(),
            eq(false), eq("Permanent failure"), any()
        );
    }

    @Test
    void consume_doesNotRequeue_whenRetriesExhausted() {
        SyncJob job = queuedJob(5, 5);
        when(syncJobRepository.findById(job.getId())).thenReturn(Optional.of(job));
        doThrow(new RuntimeException("Fatal")).when(syncDispatcherService).dispatch(any());

        assertThatThrownBy(() -> consumer.consume(message(job)))
            .isInstanceOf(AmqpRejectAndDontRequeueException.class);

        verify(syncJobProducer, never()).requeueForRetry(any());
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private SyncJob queuedJob(int retryCount, int maxRetries) {
        return jobWithStatus(SyncJobStatus.QUEUED, retryCount, maxRetries);
    }

    private SyncJob jobWithStatus(SyncJobStatus status, int retryCount, int maxRetries) {
        return SyncJob.builder()
            .id(UUID.randomUUID())
            .jobType(SyncJobType.LISTING_PUBLISH)
            .marketplaceType(MarketplaceType.REVERB)
            .status(status)
            .retryCount(retryCount)
            .maxRetries(maxRetries)
            .build();
    }

    private SyncJobMessage message(SyncJob job) {
        return SyncJobMessage.builder()
            .syncJobId(job.getId())
            .jobType(job.getJobType())
            .marketplaceType(job.getMarketplaceType())
            .attemptNumber(job.getRetryCount() + 1)
            .build();
    }

    private SyncJobMessage message(UUID jobId) {
        return SyncJobMessage.builder()
            .syncJobId(jobId)
            .jobType(SyncJobType.LISTING_PUBLISH)
            .marketplaceType(MarketplaceType.REVERB)
            .attemptNumber(1)
            .build();
    }
}
