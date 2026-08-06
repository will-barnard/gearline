import PgBoss from 'pg-boss';

import { config } from '../config.js';
import { loggerFor } from '../logger.js';

const log = loggerFor('queue');

/**
 * pg-boss replaces RabbitMQ. One fewer container, one fewer thing to secure,
 * and one very large correctness win described below.
 *
 * ── What we gain ─────────────────────────────────────────────────────────────
 *
 * SyncJobProducer went to real effort to avoid a specific bug: RabbitMQ is not
 * transactional with Postgres, so publishing a message inside a DB transaction
 * could deliver a job to a consumer before (or without) the row it describes
 * being committed. The Java fix was to register a TransactionSynchronization and
 * publish in afterCommit().
 *
 * With pg-boss the queue lives IN Postgres, so the enqueue can join the same
 * transaction as the sync_jobs insert. Either both commit or neither does. The
 * afterCommit dance becomes unnecessary rather than merely reimplemented — see
 * sync-job-producer.ts, which passes the Kysely transaction straight through.
 *
 * ── What we must not lose ────────────────────────────────────────────────────
 *
 * pg-boss has its own retry machinery, but the Java system deliberately did NOT
 * use the broker's retries: it marks a job FAILED with a nextRetryAt and lets a
 * separate poller re-enqueue it, so that retryCount and failureReason are
 * visible in the sync_jobs table and replayable from the UI. That behaviour is
 * user-facing (the Sync Activity page reads those columns), so we keep the same
 * design and configure pg-boss with retryLimit: 0 — our scheduler owns retries,
 * not the queue.
 */

let boss: PgBoss | null = null;

export async function startQueue(): Promise<PgBoss> {
  if (boss) return boss;

  boss = new PgBoss({
    connectionString: config.database.url,
    schema: config.queue.schema,
    // Keep pg-boss's pool small; it is separate from the Kysely pool and both
    // draw on the same Postgres max_connections.
    max: 4,
    // Completed jobs are archived after 12h and deleted after 7d. sync_jobs is
    // the durable record the UI reads, so pg-boss rows are just transport and
    // do not need long retention.
    archiveCompletedAfterSeconds: 12 * 60 * 60,
    deleteAfterDays: 7,
    // Our own scheduler owns retries — see the note above.
    retryLimit: 0,
  });

  boss.on('error', (err) => {
    log.error({ err }, 'pg-boss error');
  });

  await boss.start();
  await boss.createQueue(config.queue.syncQueue);

  log.info({ queue: config.queue.syncQueue, schema: config.queue.schema }, 'Job queue started');
  return boss;
}

export function getQueue(): PgBoss {
  if (!boss) {
    throw new Error('Job queue accessed before startQueue() completed');
  }
  return boss;
}

export async function stopQueue(): Promise<void> {
  if (!boss) return;
  // graceful: let in-flight handlers finish before closing the pool.
  await boss.stop({ graceful: true, timeout: 30_000 });
  boss = null;
  log.info('Job queue stopped');
}
