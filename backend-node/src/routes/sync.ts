import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { parsePageRequest, toPage } from '../db/page.js';
import type { SyncJobStatus } from '../db/types.js';
import { toSyncJobDto } from '../dto/mappers.js';
import { asyncHandler, ResourceNotFoundError } from '../http/errors.js';
import { currentUser, requireRole } from '../security/auth-middleware.js';
import { enqueue } from '../queue/sync-job-producer.js';
import * as audit from '../services/audit.js';

/** Port of SyncJobController. Mounted at /api/v1/sync. */
export const syncRouter: Router = Router();

const uuidSchema = z.string().uuid('must be a valid UUID');

const SYNC_STATUSES: SyncJobStatus[] = [
  'QUEUED',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'DEAD_LETTERED',
  'CANCELLED',
];

// ── GET /jobs ────────────────────────────────────────────────────────────────

syncRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const { page, size } = parsePageRequest(req.query, { maxSize: 200, defaultSize: 50 });
    const status = req.query.status as SyncJobStatus | undefined;
    const filterStatus = status && SYNC_STATUSES.includes(status) ? status : null;

    let listQuery = db.selectFrom('sync_jobs').selectAll();
    let countQuery = db.selectFrom('sync_jobs').select((eb) => eb.fn.countAll<string>().as('count'));

    if (filterStatus) {
      listQuery = listQuery.where('status', '=', filterStatus);
      countQuery = countQuery.where('status', '=', filterStatus);
    }

    const [rows, countRow] = await Promise.all([
      listQuery.orderBy('created_at', 'desc').limit(size).offset(page * size).execute(),
      countQuery.executeTakeFirst(),
    ]);

    const total = Number.parseInt(countRow?.count ?? '0', 10);
    res.json(toPage(rows.map(toSyncJobDto), total, page, size));
  }),
);

// ── POST /jobs/cancel-queued ─────────────────────────────────────────────────

/**
 * Declared before /jobs/:id so "cancel-queued" is not parsed as an id.
 *
 * Bulk-drains the queue after a bad import batch. ADMIN only.
 *
 * Note this cancels the sync_jobs rows but does not remove the corresponding
 * pg-boss messages — the consumer re-checks status on pickup and skips
 * CANCELLED jobs, which is the same guard the RabbitMQ consumer had.
 */
syncRouter.post(
  '/jobs/cancel-queued',
  requireRole('ADMIN'),
  asyncHandler(async (_req, res) => {
    const cancelled = await db
      .updateTable('sync_jobs')
      .set({ status: 'CANCELLED', updated_at: new Date() })
      .where('status', '=', 'QUEUED')
      .returning('id')
      .execute();

    res.json({ cancelled: cancelled.length });
  }),
);

// ── GET /jobs/:id ────────────────────────────────────────────────────────────

syncRouter.get(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const job = await db.selectFrom('sync_jobs').selectAll().where('id', '=', id).executeTakeFirst();

    if (!job) throw new ResourceNotFoundError('SyncJob', id);

    res.json(toSyncJobDto(job));
  }),
);

// ── POST /jobs/:id/replay ────────────────────────────────────────────────────

/**
 * Replays a failed or dead-lettered job by enqueueing a fresh copy.
 *
 * The copy deliberately carries NO idempotency key even if the original had
 * one — the whole point of a replay is to run work that the key would otherwise
 * suppress as a duplicate. ADMIN or OPERATOR.
 */
syncRouter.post(
  '/jobs/:id/replay',
  requireRole('ADMIN', 'OPERATOR'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = uuidSchema.parse(req.params.id);

    const original = await db
      .selectFrom('sync_jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!original) throw new ResourceNotFoundError('SyncJob', id);

    const replay = await enqueue({
      jobType: original.job_type,
      marketplaceType: original.marketplace_type,
      marketplaceAccountId: original.marketplace_account_id,
      productId: original.product_id,
      listingId: original.listing_id,
      payload: original.payload ?? {},
    });

    audit.recordMarketplaceEvent(
      'SYNC_JOB_REPLAYED',
      original.marketplace_type,
      user.id,
      'SyncJob',
      original.id,
      true,
      null,
      { replayJobId: replay.id },
    );

    res.json(toSyncJobDto(replay));
  }),
);

// ── POST /jobs/:id/cancel ────────────────────────────────────────────────────

syncRouter.post(
  '/jobs/:id/cancel',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const job = await db
      .selectFrom('sync_jobs')
      .select(['id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!job) throw new ResourceNotFoundError('SyncJob', id);

    // Only QUEUED jobs can be cancelled — an IN_PROGRESS job is already talking
    // to a marketplace API and cancelling the row would not stop it.
    if (job.status !== 'QUEUED') {
      res.status(400).end();
      return;
    }

    await db
      .updateTable('sync_jobs')
      .set({ status: 'CANCELLED', updated_at: new Date() })
      .where('id', '=', id)
      .where('status', '=', 'QUEUED')
      .execute();

    res.status(204).end();
  }),
);
