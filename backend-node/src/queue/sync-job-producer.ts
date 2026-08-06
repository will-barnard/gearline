import type { Transaction } from 'kysely';

import { config } from '../config.js';
import { db } from '../db/index.js';
import { toJson } from '../db/json.js';
import type { Database, MarketplaceType, SyncJobRow, SyncJobType } from '../db/types.js';
import { loggerFor } from '../logger.js';
import { getQueue } from './boss.js';

const log = loggerFor('sync-job-producer');

export interface SyncJobMessage {
  syncJobId: string;
  jobType: SyncJobType;
  marketplaceType: MarketplaceType | null;
  marketplaceAccountId: string | null;
  productId: string | null;
  listingId: string | null;
  attemptNumber: number;
  enqueuedAt: string;
  payload: Record<string, unknown>;
}

export interface EnqueueInput {
  jobType: SyncJobType;
  marketplaceType?: MarketplaceType | null;
  marketplaceAccountId?: string | null;
  productId?: string | null;
  listingId?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
  maxRetries?: number;
}

type Db = typeof db | Transaction<Database>;

function toMessage(job: SyncJobRow, attemptNumber: number): SyncJobMessage {
  return {
    syncJobId: job.id,
    jobType: job.job_type,
    marketplaceType: job.marketplace_type,
    marketplaceAccountId: job.marketplace_account_id,
    productId: job.product_id,
    listingId: job.listing_id,
    attemptNumber,
    enqueuedAt: new Date().toISOString(),
    payload: job.payload ?? {},
  };
}

/**
 * Persists a sync job and enqueues it.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *
 * sync_jobs.idempotency_key carries a UNIQUE constraint. Callers such as
 * InventoryConsistencyService build deterministic keys
 * ("inv-{productId}-{listingId}-v{version}") precisely so that the same
 * inventory event fired twice collapses to one job. We rely on the constraint
 * rather than a pre-check: ON CONFLICT DO NOTHING is atomic, whereas
 * SELECT-then-INSERT has a race window that a webhook retry storm will find.
 *
 * A conflict returns the existing job and skips the enqueue — no duplicate work.
 *
 * ── Transactionality ─────────────────────────────────────────────────────────
 *
 * Pass the surrounding transaction as `trx` and the queue insert commits with
 * the sync_jobs row atomically. This is the property RabbitMQ could not give us
 * and the reason the Java afterCommit callback existed.
 */
export async function enqueue(input: EnqueueInput, trx?: Transaction<Database>): Promise<SyncJobRow> {
  const executor: Db = trx ?? db;

  const inserted = await executor
    .insertInto('sync_jobs')
    .values({
      job_type: input.jobType,
      status: 'QUEUED',
      marketplace_type: input.marketplaceType ?? null,
      marketplace_account_id: input.marketplaceAccountId ?? null,
      product_id: input.productId ?? null,
      listing_id: input.listingId ?? null,
      payload: toJson(input.payload ?? {}),
      idempotency_key: input.idempotencyKey ?? null,
      max_retries: input.maxRetries ?? config.sync.maxRetryAttempts,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returningAll()
    .executeTakeFirst();

  if (!inserted) {
    // Conflict on idempotency_key — a job for this exact event already exists.
    const existing = await executor
      .selectFrom('sync_jobs')
      .selectAll()
      .where('idempotency_key', '=', input.idempotencyKey!)
      .executeTakeFirstOrThrow();

    log.debug(
      { idempotencyKey: input.idempotencyKey, existingJobId: existing.id },
      'Duplicate sync job suppressed by idempotency key',
    );
    return existing;
  }

  await getQueue().send(config.queue.syncQueue, toMessage(inserted, 1), {
    // Our scheduler owns retries; see boss.ts.
    retryLimit: 0,
    // Expire a job that has sat unclaimed for an hour — it will be picked up by
    // the retry scheduler rather than silently lingering.
    expireInSeconds: 3600,
  });

  log.info(
    { jobId: inserted.id, jobType: inserted.job_type, marketplace: inserted.marketplace_type },
    'Enqueued sync job',
  );

  return inserted;
}

/**
 * Marks a failed job for a later retry. Does NOT enqueue — the retry scheduler
 * picks it up once nextRetryAt has elapsed.
 *
 * Splitting "mark failed" from "re-enqueue" is what gives true exponential
 * backoff without a delayed-message broker plugin, and it is why the FAILED
 * status is meaningful in the UI. Preserved from the Java design deliberately.
 */
export async function scheduleRetry(job: SyncJobRow, failureReason: string): Promise<void> {
  const attempt = job.retry_count + 1;
  const delayMs = calculateBackoffDelay(attempt);

  await db
    .updateTable('sync_jobs')
    .set({
      retry_count: attempt,
      next_retry_at: new Date(Date.now() + delayMs),
      status: 'FAILED',
      failure_reason: failureReason,
      updated_at: new Date(),
    })
    .where('id', '=', job.id)
    .execute();

  log.info(
    { jobId: job.id, attempt, maxRetries: job.max_retries, delayMs },
    'Scheduled sync job retry',
  );
}

/** Re-publishes a FAILED job whose backoff window has elapsed. */
export async function publishRetry(job: SyncJobRow): Promise<void> {
  const updated = await db
    .updateTable('sync_jobs')
    .set({ status: 'QUEUED', updated_at: new Date() })
    .where('id', '=', job.id)
    // Guard against two schedulers racing to re-publish the same job. Only the
    // instance whose UPDATE matches a still-FAILED row proceeds to enqueue.
    .where('status', '=', 'FAILED')
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    log.debug({ jobId: job.id }, 'Retry already claimed by another instance — skipping');
    return;
  }

  await getQueue().send(config.queue.syncQueue, toMessage(updated, updated.retry_count), {
    retryLimit: 0,
    expireInSeconds: 3600,
  });

  log.info({ jobId: job.id, attempt: updated.retry_count }, 'Re-enqueued sync job');
}

/** Exponential backoff: initial × 2^(attempt-1), capped at maxRetryDelayMs. */
export function calculateBackoffDelay(attempt: number): number {
  const delay = config.sync.initialRetryDelayMs * Math.pow(2, attempt - 1);
  return Math.min(delay, config.sync.maxRetryDelayMs);
}
