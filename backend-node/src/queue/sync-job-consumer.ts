import { config } from '../config.js';
import { db } from '../db/index.js';
import { loggerFor } from '../logger.js';
import { hasConnector } from '../marketplace/registry.js';
import { isRetryable } from '../marketplace/types.js';
import { dispatch, markDelistFailed } from '../services/sync-dispatcher.js';
import * as audit from '../services/audit.js';
import { getQueue } from './boss.js';
import { scheduleRetry, type SyncJobMessage } from './sync-job-producer.js';

const log = loggerFor('sync-job-consumer');

/**
 * Port of SyncJobConsumer.
 *
 * ── Why there is no surrounding transaction ──────────────────────────────────
 *
 * The Java class carries a long comment explaining that consume() must NOT be
 * @Transactional, and the reasoning transfers directly even though the mechanism
 * does not.
 *
 * In Spring, an exception from dispatch() marked an enclosing transaction
 * rollback-only BEFORE the catch block ran, so every bookkeeping write in that
 * catch — retryCount, failure reason, dead-lettering — was silently rolled back.
 * The message had already been published to RabbitMQ, so the job retried
 * forever with retryCount stuck at 0.
 *
 * Node has no ambient transaction, so that particular trap cannot occur. The
 * property it was protecting still matters and is preserved explicitly here:
 * FAILURE BOOKKEEPING MUST COMMIT INDEPENDENTLY OF THE WORK THAT FAILED. Each
 * status write below is its own statement. Do not wrap this handler in
 * db.transaction() — it would reintroduce the original bug.
 *
 * ── Retry model ──────────────────────────────────────────────────────────────
 *
 * pg-boss is configured with retryLimit: 0 so it never retries on its own.
 * Failures are recorded as FAILED with a nextRetryAt, and the retry scheduler
 * re-enqueues once the backoff has elapsed. That keeps retryCount and
 * failureReason visible in sync_jobs, which is what the Sync Activity page
 * reads and what makes a job replayable from the UI.
 */

export async function startConsumer(): Promise<void> {
  const boss = getQueue();

  await boss.work<SyncJobMessage>(
    config.queue.syncQueue,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([pgBossJob]) => {
      if (!pgBossJob) return;
      await handleMessage(pgBossJob.data);
    },
  );

  log.info(
    { queue: config.queue.syncQueue, concurrency: config.queue.concurrency },
    'Sync job consumer started',
  );
}

async function handleMessage(message: SyncJobMessage): Promise<void> {
  log.info(
    {
      jobId: message.syncJobId,
      jobType: message.jobType,
      marketplace: message.marketplaceType,
      attempt: message.attemptNumber,
    },
    'Processing sync job',
  );

  const job = await db
    .selectFrom('sync_jobs')
    .selectAll()
    .where('id', '=', message.syncJobId)
    .executeTakeFirst();

  if (!job) {
    // The row is gone but the message survived. Nothing to do — and crucially,
    // do NOT throw, or the queue would keep redelivering a job that cannot
    // exist.
    log.warn({ jobId: message.syncJobId }, 'Sync job not found in database — skipping');
    return;
  }

  // Cancelled or already-completed jobs are skipped. This is what makes the
  // bulk "cancel queued jobs" endpoint work without having to purge the queue:
  // the messages still arrive, and are dropped here.
  if (job.status === 'CANCELLED' || job.status === 'COMPLETED') {
    log.debug({ jobId: job.id, status: job.status }, 'Sync job already resolved — skipping');
    return;
  }

  /**
   * ── Partial-port guard ─────────────────────────────────────────────────────
   *
   * There is ONE queue for all marketplaces, so once any connector is
   * registered this consumer starts receiving jobs for every marketplace —
   * including ones still owned by the Java service.
   *
   * Without this check, a Shopify job picked up during the Reverb-only phase
   * would fail in getConnector(), burn the retry ladder, and dead-letter — a
   * job that Java could have handled perfectly well.
   *
   * Instead we leave the row QUEUED and acknowledge the message. The job stays
   * visible and replayable from the Sync Activity page, and becomes
   * processable the moment its connector is registered. Deliberately NOT
   * thrown: throwing would just redeliver it in a loop.
   *
   * This whole branch is dead code once all three connectors are registered.
   */
  if (job.marketplace_type && !hasConnector(job.marketplace_type)) {
    log.warn(
      { jobId: job.id, marketplace: job.marketplace_type, jobType: job.job_type },
      'No connector registered for this marketplace yet — leaving job QUEUED for later. ' +
        'This is expected while the connector port is in progress.',
    );

    await db
      .updateTable('sync_jobs')
      .set({ status: 'QUEUED', started_at: null, updated_at: new Date() })
      .where('id', '=', job.id)
      .execute();

    return;
  }

  await db
    .updateTable('sync_jobs')
    .set({ status: 'IN_PROGRESS', started_at: new Date(), updated_at: new Date() })
    .where('id', '=', job.id)
    .execute();

  audit.recordMarketplaceEvent(
    'SYNC_JOB_STARTED',
    job.marketplace_type,
    null,
    'SyncJob',
    job.id,
    true,
    null,
    { jobType: job.job_type },
  );

  try {
    await dispatch(job);

    await db
      .updateTable('sync_jobs')
      .set({ status: 'COMPLETED', completed_at: new Date(), updated_at: new Date() })
      .where('id', '=', job.id)
      .execute();

    audit.recordMarketplaceEvent(
      'SYNC_JOB_COMPLETED',
      job.marketplace_type,
      null,
      'SyncJob',
      job.id,
      true,
      null,
      { jobType: job.job_type },
    );
  } catch (err) {
    await handleFailure(job.id, message.attemptNumber, err);
  }
}

async function handleFailure(jobId: string, attempt: number, err: unknown): Promise<void> {
  const failureReason = err instanceof Error ? err.message : String(err);

  log.error({ err, jobId, attempt }, 'Sync job failed');

  /**
   * Re-read the job to get the true persisted retryCount. The copy we started
   * with predates anything dispatch() may have written, and basing the retry
   * decision on a stale count is how a job ends up retrying past its limit.
   */
  const job = await db
    .selectFrom('sync_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst();

  if (!job) {
    log.error({ jobId }, 'Sync job vanished while handling failure');
    return;
  }

  // A permanent error skips the ladder entirely. Retrying a payload the
  // marketplace has definitively rejected wastes five attempts and delays the
  // operator seeing the real problem.
  const retryable = isRetryable(err);
  const hasAttemptsLeft = job.retry_count < job.max_retries;

  if (retryable && hasAttemptsLeft) {
    await scheduleRetry(job, failureReason);

    audit.recordMarketplaceEvent(
      'SYNC_JOB_FAILED',
      job.marketplace_type,
      null,
      'SyncJob',
      job.id,
      false,
      failureReason,
      { attempt: String(attempt), willRetry: 'true' },
    );
    return;
  }

  await db
    .updateTable('sync_jobs')
    .set({ status: 'DEAD_LETTERED', failure_reason: failureReason, updated_at: new Date() })
    .where('id', '=', job.id)
    .execute();

  // A dead-lettered delist leaves a listing ACTIVE in our records that may
  // still be live on the marketplace. Flag it for manual attention.
  if (job.job_type === 'LISTING_DELIST') {
    await markDelistFailed({ ...job, failure_reason: failureReason });
  }

  audit.recordMarketplaceEvent(
    'SYNC_JOB_DEAD_LETTERED',
    job.marketplace_type,
    null,
    'SyncJob',
    job.id,
    false,
    failureReason,
    { permanent: String(!retryable) },
  );

  log.error(
    { jobId: job.id, jobType: job.job_type, permanent: !retryable },
    'Sync job dead-lettered',
  );

  // Deliberately NOT rethrown. pg-boss has retryLimit: 0, so throwing would
  // only mark the queue message failed without changing behaviour, while
  // adding noise to the pg-boss error log.
}
