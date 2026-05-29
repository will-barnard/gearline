-- Async sync job queue — persisted state for all asynchronous orchestration work
CREATE TABLE sync_jobs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type                VARCHAR(50) NOT NULL,
    status                  VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    marketplace_type        VARCHAR(30),
    marketplace_account_id  UUID,
    product_id              UUID,
    listing_id              UUID,

    retry_count             INTEGER NOT NULL DEFAULT 0,
    max_retries             INTEGER NOT NULL DEFAULT 5,
    next_retry_at           TIMESTAMPTZ,

    -- Structured job payload
    payload                 JSONB NOT NULL DEFAULT '{}',

    -- Timing
    started_at              TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    failure_reason          TEXT,

    -- Idempotency — prevents double-processing the same external event
    idempotency_key         VARCHAR(200) UNIQUE,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_sync_job_status CHECK (status IN (
        'QUEUED','IN_PROGRESS','COMPLETED','FAILED','DEAD_LETTERED','CANCELLED'
    ))
);

CREATE INDEX idx_sync_jobs_status ON sync_jobs(status);
CREATE INDEX idx_sync_jobs_job_type ON sync_jobs(job_type);
CREATE INDEX idx_sync_jobs_account_id ON sync_jobs(marketplace_account_id);
CREATE INDEX idx_sync_jobs_product_id ON sync_jobs(product_id);
CREATE INDEX idx_sync_jobs_created_at ON sync_jobs(created_at DESC);
CREATE INDEX idx_sync_jobs_next_retry ON sync_jobs(next_retry_at)
    WHERE status = 'FAILED' AND next_retry_at IS NOT NULL;

COMMENT ON TABLE sync_jobs IS 'Persistent async sync job log — supports retry, replay, and audit';
COMMENT ON COLUMN sync_jobs.idempotency_key IS 'Prevents duplicate processing of the same external event (e.g. webhook)';
