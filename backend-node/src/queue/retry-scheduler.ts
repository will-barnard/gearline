import { config } from '../config.js';
import { db, sql } from '../db/index.js';
import { loggerFor } from '../logger.js';
import { publishRetry } from './sync-job-producer.js';

const log = loggerFor('retry-scheduler');

/**
 * Port of SyncJobRetryScheduler.
 *
 * Polls for FAILED jobs whose nextRetryAt has elapsed and re-enqueues them.
 * This is what gives true exponential backoff without a delayed-message broker,
 * and it is why retryCount and failureReason stay visible in the UI rather than
 * being hidden inside broker internals.
 *
 * The query matches findJobsDueForRetry exactly:
 *   status = 'FAILED' AND next_retry_at <= now AND retry_count < max_retries
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function retryDueJobs(): Promise<void> {
  // Skip if the previous tick is still going. Without this, a slow batch would
  // overlap with the next tick and double-publish the same jobs.
  if (running) {
    log.debug('Previous retry sweep still running — skipping this tick');
    return;
  }

  running = true;

  try {
    const due = await db
      .selectFrom('sync_jobs')
      .selectAll()
      .where('status', '=', 'FAILED')
      .where('next_retry_at', '<=', new Date())
      .where(sql<boolean>`retry_count < max_retries`)
      // Bound the batch so one sweep cannot monopolise the process after an
      // outage has produced thousands of failures.
      .orderBy('next_retry_at', 'asc')
      .limit(200)
      .execute();

    if (due.length === 0) return;

    log.info({ count: due.length }, 'FAILED jobs due for re-enqueue');

    for (const job of due) {
      try {
        await publishRetry(job);
      } catch (err) {
        // One bad job must not stop the sweep.
        log.error({ err, jobId: job.id }, 'Failed to re-enqueue sync job');
      }
    }
  } catch (err) {
    log.error({ err }, 'Retry sweep failed');
  } finally {
    running = false;
  }
}

export function startRetryScheduler(): void {
  if (timer) return;

  const { retryPollIntervalMs, retryPollInitialDelayMs } = config.sync;

  // setTimeout then setInterval reproduces Spring's initialDelay + fixedDelay.
  setTimeout(() => {
    void retryDueJobs();
    timer = setInterval(() => void retryDueJobs(), retryPollIntervalMs);
  }, retryPollInitialDelayMs).unref();

  log.info(
    { intervalMs: retryPollIntervalMs, initialDelayMs: retryPollInitialDelayMs },
    'Retry scheduler started',
  );
}

export function stopRetryScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info('Retry scheduler stopped');
  }
}
