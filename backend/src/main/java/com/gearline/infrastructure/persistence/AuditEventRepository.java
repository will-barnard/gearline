package com.gearline.infrastructure.persistence;

import com.gearline.domain.audit.AuditEvent;
import com.gearline.domain.audit.AuditEventType;
import com.gearline.marketplace.common.connector.MarketplaceType;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.UUID;

@Repository
public interface AuditEventRepository extends JpaRepository<AuditEvent, UUID> {
    Page<AuditEvent> findByEventType(AuditEventType type, Pageable pageable);
    Page<AuditEvent> findByMarketplaceType(MarketplaceType type, Pageable pageable);
    Page<AuditEvent> findByEntityTypeAndEntityId(String entityType, String entityId, Pageable pageable);
    Page<AuditEvent> findBySuccessFalse(Pageable pageable);
    Page<AuditEvent> findByCreatedAtBetween(Instant from, Instant to, Pageable pageable);
}
