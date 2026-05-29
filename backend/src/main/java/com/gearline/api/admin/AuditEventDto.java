package com.gearline.api.admin;

import com.gearline.domain.audit.AuditEvent;
import com.gearline.domain.audit.AuditEventType;
import com.gearline.marketplace.common.connector.MarketplaceType;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

public record AuditEventDto(
    UUID id,
    AuditEventType eventType,
    UUID actorId,
    String actorName,
    String entityType,
    String entityId,
    MarketplaceType marketplaceType,
    Boolean success,
    String errorMessage,
    Map<String, Object> metadata,
    Instant createdAt
) {
    public static AuditEventDto from(AuditEvent e) {
        return new AuditEventDto(
            e.getId(), e.getEventType(), e.getActorId(), e.getActorName(),
            e.getEntityType(), e.getEntityId(), e.getMarketplaceType(),
            e.getSuccess(), e.getErrorMessage(), e.getMetadata(), e.getCreatedAt()
        );
    }
}
