package com.gearline.domain.audit;

import com.gearline.marketplace.common.connector.MarketplaceType;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "audit_events", indexes = {
    @Index(name = "idx_audit_events_type", columnList = "event_type"),
    @Index(name = "idx_audit_events_actor_id", columnList = "actor_id"),
    @Index(name = "idx_audit_events_entity", columnList = "entity_type, entity_id"),
    @Index(name = "idx_audit_events_marketplace_type", columnList = "marketplace_type"),
    @Index(name = "idx_audit_events_created_at", columnList = "created_at"),
    @Index(name = "idx_audit_events_success", columnList = "success")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
@EqualsAndHashCode(of = "id")
public class AuditEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Enumerated(EnumType.STRING)
    @Column(name = "event_type", nullable = false, length = 60)
    private AuditEventType eventType;

    /** The user or system actor who triggered this event */
    @Column(name = "actor_id")
    private UUID actorId;

    @Column(name = "actor_name", length = 200)
    private String actorName;

    /** The domain entity this event applies to */
    @Column(name = "entity_type", length = 60)
    private String entityType;

    @Column(name = "entity_id", length = 100)
    private String entityId;

    @Enumerated(EnumType.STRING)
    @Column(name = "marketplace_type", length = 30)
    private MarketplaceType marketplaceType;

    @Column(nullable = false)
    @Builder.Default
    private Boolean success = true;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;

    /** Contextual data for the event (before/after values, payload summaries, etc.) */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    @Builder.Default
    private Map<String, Object> metadata = new HashMap<>();

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @PrePersist
    protected void prePersist() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }
}
