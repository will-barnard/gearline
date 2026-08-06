import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { parsePageRequest, toPage } from '../db/page.js';
import type { AuditEventType, MarketplaceType, UserRole } from '../db/types.js';
import { toAuditEventDto, toUserDto } from '../dto/mappers.js';
import { asyncHandler, ResourceNotFoundError } from '../http/errors.js';
import { requireRole } from '../security/auth-middleware.js';
import { hashPassword } from '../security/password.js';

const uuidSchema = z.string().uuid('must be a valid UUID');

const USER_ROLES: UserRole[] = ['ADMIN', 'OPERATOR', 'VIEWER'];

// ─────────────────────────────────────────────────────────────────────────────
// Users — /api/v1/admin/users
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Port of UserController.
 *
 * Every route is ADMIN-only. In Java this was enforced twice (a class-level
 * @PreAuthorize plus the /api/v1/admin/** matcher in SecurityConfig); the
 * router-level guard here is the single equivalent.
 */
export const adminUsersRouter: Router = Router();

adminUsersRouter.use(requireRole('ADMIN'));

const createUserSchema = z.object({
  email: z.string().min(1, 'must not be blank').email('must be a well-formed email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  role: z.enum(USER_ROLES as [UserRole, ...UserRole[]]),
});

const updateUserSchema = z.object({
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  role: z.enum(USER_ROLES as [UserRole, ...UserRole[]]).nullish(),
  active: z.boolean().nullish(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

adminUsersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await db.selectFrom('users').selectAll().orderBy('created_at', 'desc').execute();
    res.json(users.map(toUserDto));
  }),
);

adminUsersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const user = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    if (!user) throw new ResourceNotFoundError('User', id);
    res.json(toUserDto(user));
  }),
);

adminUsersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body);

    const existing = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', body.email)
      .executeTakeFirst();

    if (existing) {
      // Java returned a bare 409 with no body here.
      res.status(409).end();
      return;
    }

    const saved = await db
      .insertInto('users')
      .values({
        email: body.email,
        password_hash: await hashPassword(body.password),
        first_name: body.firstName ?? '',
        last_name: body.lastName ?? '',
        role: body.role,
        active: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    res.status(201).json(toUserDto(saved));
  }),
);

adminUsersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const body = updateUserSchema.parse(req.body);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (body.firstName != null) patch.first_name = body.firstName;
    if (body.lastName != null) patch.last_name = body.lastName;
    if (body.role != null) patch.role = body.role;
    if (body.active != null) patch.active = body.active;

    const saved = await db
      .updateTable('users')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!saved) throw new ResourceNotFoundError('User', id);

    res.json(toUserDto(saved));
  }),
);

adminUsersRouter.post(
  '/:id/reset-password',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const { password } = resetPasswordSchema.parse(req.body);

    const updated = await db
      .updateTable('users')
      .set({ password_hash: await hashPassword(password), updated_at: new Date() })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();

    if (!updated) throw new ResourceNotFoundError('User', id);

    res.status(204).end();
  }),
);

/** Soft delete — deactivates rather than removing, preserving audit history. */
adminUsersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const updated = await db
      .updateTable('users')
      .set({ active: false, updated_at: new Date() })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();

    if (!updated) throw new ResourceNotFoundError('User', id);

    res.status(204).end();
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — /api/v1/admin/dashboard
// ─────────────────────────────────────────────────────────────────────────────

/** Port of DashboardController. */
export const dashboardRouter: Router = Router();

dashboardRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    /**
     * The Java version fired eight separate COUNT queries through JPA. These
     * are collapsed into three round trips: one grouped count over listings,
     * one grouped count over sync jobs, and one batch of table counts. Same
     * numbers, materially less work for the database on a screen that is
     * polled by every open dashboard tab.
     */
    const [listingCounts, jobCounts, totals] = await Promise.all([
      db
        .selectFrom('marketplace_listings')
        .select(['listing_status', (eb) => eb.fn.countAll<string>().as('count')])
        .where('listing_status', 'in', ['ACTIVE', 'FAILED', 'NEEDS_REVIEW'])
        .groupBy('listing_status')
        .execute(),

      db
        .selectFrom('sync_jobs')
        .select(['status', (eb) => eb.fn.countAll<string>().as('count')])
        .where('status', 'in', ['FAILED', 'IN_PROGRESS'])
        .groupBy('status')
        .execute(),

      Promise.all([
        db.selectFrom('products').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst(),
        db.selectFrom('orders').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst(),
        db
          .selectFrom('marketplace_accounts')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('active', '=', true)
          .executeTakeFirst(),
      ]),
    ]);

    const listingBy = new Map(listingCounts.map((r) => [r.listing_status, Number(r.count)]));
    const jobBy = new Map(jobCounts.map((r) => [r.status, Number(r.count)]));
    const [productsRow, ordersRow, accountsRow] = totals;

    res.json({
      totalProducts: Number(productsRow?.count ?? 0),
      activeListings: listingBy.get('ACTIVE') ?? 0,
      failedListings: listingBy.get('FAILED') ?? 0,
      pendingReviewListings: listingBy.get('NEEDS_REVIEW') ?? 0,
      totalOrders: Number(ordersRow?.count ?? 0),
      failedSyncJobs: jobBy.get('FAILED') ?? 0,
      inProgressSyncJobs: jobBy.get('IN_PROGRESS') ?? 0,
      connectedAccounts: Number(accountsRow?.count ?? 0),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Audit log — /api/v1/audit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Port of AuditLogController.
 *
 * Note this is mounted at /api/v1/audit, NOT under /api/v1/admin — so it is
 * available to any authenticated user, not just admins. That matches
 * SecurityConfig, where only /api/v1/admin/** carried the ADMIN requirement.
 */
export const auditRouter: Router = Router();

auditRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, size } = parsePageRequest(req.query, { maxSize: 200, defaultSize: 50 });

    let listQuery = db.selectFrom('audit_events').selectAll();
    let countQuery = db
      .selectFrom('audit_events')
      .select((eb) => eb.fn.countAll<string>().as('count'));

    /**
     * Filter precedence is if/else-if, exactly as in Java: a date range wins
     * over eventType, which wins over marketplaceType, which wins over
     * successOnly. Combining them is NOT supported. Reproduced rather than
     * "fixed" because the UI was built against this behaviour — making the
     * filters additive here would change results for existing saved views.
     */
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    const to = typeof req.query.to === 'string' ? req.query.to : null;
    const eventType = req.query.eventType as AuditEventType | undefined;
    const marketplaceType = req.query.marketplaceType as MarketplaceType | undefined;
    const successOnly = req.query.successOnly;

    if (from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to);

      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        res.status(400).json({
          title: 'Invalid date range',
          status: 400,
          detail: 'from and to must be ISO-8601 instants',
        });
        return;
      }

      listQuery = listQuery.where('created_at', '>=', fromDate).where('created_at', '<=', toDate);
      countQuery = countQuery.where('created_at', '>=', fromDate).where('created_at', '<=', toDate);
    } else if (eventType) {
      listQuery = listQuery.where('event_type', '=', eventType);
      countQuery = countQuery.where('event_type', '=', eventType);
    } else if (marketplaceType) {
      listQuery = listQuery.where('marketplace_type', '=', marketplaceType);
      countQuery = countQuery.where('marketplace_type', '=', marketplaceType);
    } else if (String(successOnly) === 'false') {
      listQuery = listQuery.where('success', '=', false);
      countQuery = countQuery.where('success', '=', false);
    }

    const [rows, countRow] = await Promise.all([
      listQuery.orderBy('created_at', 'desc').limit(size).offset(page * size).execute(),
      countQuery.executeTakeFirst(),
    ]);

    const total = Number.parseInt(countRow?.count ?? '0', 10);
    res.json(toPage(rows.map(toAuditEventDto), total, page, size));
  }),
);
