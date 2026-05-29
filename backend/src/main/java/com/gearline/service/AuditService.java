package com.gearline.service;

import com.gearline.domain.audit.AuditEvent;
import com.gearline.domain.audit.AuditEventType;
import com.gearline.infrastructure.persistence.AuditEventRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class AuditService {

    private final AuditEventRepository auditEventRepository;

    /**
     * Records an audit event asynchronously in a new transaction.
     * Using a separate transaction ensures audit logs persist even if the calling transaction rolls back.
     */
    @Async
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(
        AuditEventType type,
        UUID actorId,
        String entityType,
        String entityId,
        boolean success,
        String errorMessage,
        Map<String, Object> metadata
    ) {
        try {
            AuditEvent event = AuditEvent.builder()
                .eventType(type)
                .actorId(actorId)
                .entityType(entityType)
                .entityId(entityId)
                .success(success)
                .errorMessage(errorMessage)
                .metadata(metadata != null ? metadata : Map.of())
                .build();

            auditEventRepository.save(event);
        } catch (Exception e) {
            // Audit failures must never crash the calling operation
            log.error("Failed to record audit event {} for entity {}/{}: {}", type, entityType, entityId, e.getMessage());
        }
    }

    @Async
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordMarketplaceEvent(
        AuditEventType type,
        MarketplaceType marketplaceType,
        UUID actorId,
        String entityType,
        String entityId,
        boolean success,
        String errorMessage,
        Map<String, Object> metadata
    ) {
        try {
            AuditEvent event = AuditEvent.builder()
                .eventType(type)
                .marketplaceType(marketplaceType)
                .actorId(actorId)
                .entityType(entityType)
                .entityId(entityId)
                .success(success)
                .errorMessage(errorMessage)
                .metadata(metadata != null ? metadata : Map.of())
                .build();

            auditEventRepository.save(event);
        } catch (Exception e) {
            log.error("Failed to record marketplace audit event {}: {}", type, e.getMessage());
        }
    }
}
