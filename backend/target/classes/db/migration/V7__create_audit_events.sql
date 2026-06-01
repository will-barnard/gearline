-- Audit event log — immutable append-only record of all significant platform actions
CREATE TABLE audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      VARCHAR(60) NOT NULL,
    actor_id        UUID,
    actor_name      VARCHAR(200),
    entity_type     VARCHAR(60),
    entity_id       VARCHAR(100),
    marketplace_type VARCHAR(30),
    success         BOOLEAN NOT NULL DEFAULT TRUE,
    error_message   TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    -- No updated_at — audit events are immutable
);

CREATE INDEX idx_audit_events_type ON audit_events(event_type);
CREATE INDEX idx_audit_events_actor_id ON audit_events(actor_id);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_events_marketplace_type ON audit_events(marketplace_type);
CREATE INDEX idx_audit_events_created_at ON audit_events(created_at DESC);
CREATE INDEX idx_audit_events_success ON audit_events(success) WHERE success = FALSE;

-- Composite: useful for "all failed events for this marketplace"
CREATE INDEX idx_audit_events_marketplace_success ON audit_events(marketplace_type, success, created_at DESC);

COMMENT ON TABLE audit_events IS 'Immutable audit trail — never update or delete rows from this table';
