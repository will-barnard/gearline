package com.gearline.api.sync;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobStatus;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.domain.audit.AuditEventType;
import com.gearline.domain.user.User;
import com.gearline.infrastructure.persistence.SyncJobRepository;
import com.gearline.service.AuditService;
import com.gearline.infrastructure.messaging.SyncJobProducer;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.*;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import org.springframework.transaction.annotation.Transactional;

import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/sync")
@RequiredArgsConstructor
@Tag(name = "Sync Jobs", description = "Async sync job management and monitoring")
public class SyncJobController {

    private final SyncJobRepository syncJobRepository;
    private final SyncJobProducer syncJobProducer;
    private final AuditService auditService;

    @GetMapping("/jobs")
    @Operation(summary = "List sync jobs")
    public ResponseEntity<Page<SyncJobDto>> listJobs(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "50") int size,
        @RequestParam(required = false) SyncJobStatus status
    ) {
        Pageable pageable = PageRequest.of(page, Math.min(size, 200), Sort.by(Sort.Direction.DESC, "createdAt"));
        Page<SyncJob> jobs = status != null
            ? syncJobRepository.findByStatus(status, pageable)
            : syncJobRepository.findAll(pageable);
        return ResponseEntity.ok(jobs.map(SyncJobDto::from));
    }

    @GetMapping("/jobs/{id}")
    @Operation(summary = "Get a sync job by ID")
    public ResponseEntity<SyncJobDto> getJob(@PathVariable UUID id) {
        return ResponseEntity.ok(SyncJobDto.from(
            syncJobRepository.findById(id).orElseThrow(() -> new ResourceNotFoundException("SyncJob", id))
        ));
    }

    @PostMapping("/jobs/{id}/replay")
    @Operation(summary = "Replay a failed or dead-lettered sync job")
    @PreAuthorize("hasRole('ADMIN') or hasRole('OPERATOR')")
    public ResponseEntity<SyncJobDto> replayJob(
        @PathVariable UUID id,
        @AuthenticationPrincipal User currentUser
    ) {
        SyncJob original = syncJobRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("SyncJob", id));

        // Create a fresh job copy for replay
        SyncJob replay = SyncJob.builder()
            .jobType(original.getJobType())
            .marketplaceType(original.getMarketplaceType())
            .marketplaceAccountId(original.getMarketplaceAccountId())
            .productId(original.getProductId())
            .listingId(original.getListingId())
            .payload(original.getPayload())
            .build();

        SyncJob enqueued = syncJobProducer.enqueue(replay);

        auditService.recordMarketplaceEvent(
            AuditEventType.SYNC_JOB_REPLAYED, original.getMarketplaceType(),
            currentUser.getId(), "SyncJob", original.getId().toString(), true, null,
            Map.of("replayJobId", enqueued.getId().toString())
        );

        return ResponseEntity.ok(SyncJobDto.from(enqueued));
    }

    @PostMapping("/jobs/{id}/cancel")
    @Operation(summary = "Cancel a queued sync job")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Void> cancelJob(@PathVariable UUID id) {
        SyncJob job = syncJobRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("SyncJob", id));

        if (job.getStatus() != SyncJobStatus.QUEUED) {
            return ResponseEntity.badRequest().build();
        }

        job.setStatus(SyncJobStatus.CANCELLED);
        syncJobRepository.save(job);
        return ResponseEntity.noContent().build();
    }

    /**
     * Bulk-cancels every QUEUED sync job in a single UPDATE query.
     *
     * Use this to drain the queue after a bad historical import batch
     * (e.g. Reverb orders imported on first deploy due to a null lastSyncAt).
     * Jobs already IN_PROGRESS are unaffected — only QUEUED ones are cancelled.
     *
     * @return JSON body {@code {"cancelled": N}} with the count of cancelled jobs
     */
    @PostMapping("/jobs/cancel-queued")
    @Operation(summary = "Cancel all queued sync jobs in bulk")
    @PreAuthorize("hasRole('ADMIN')")
    @Transactional
    public ResponseEntity<Map<String, Integer>> cancelAllQueuedJobs() {
        int cancelled = syncJobRepository.cancelAllQueued();
        return ResponseEntity.ok(Map.of("cancelled", cancelled));
    }
}
