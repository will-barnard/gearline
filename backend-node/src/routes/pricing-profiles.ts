import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { toPricingProfileDto } from '../dto/mappers.js';
import { asyncHandler, ResourceNotFoundError } from '../http/errors.js';

/** Port of PricingProfileController. Mounted at /api/v1/pricing-profiles. */
export const pricingProfilesRouter: Router = Router();

const uuidSchema = z.string().uuid('must be a valid UUID');

/**
 * adjustmentPercent is NUMERIC(7,4) with @DecimalMin("-100") / @DecimalMax("1000").
 * Validated as a string to preserve precision, then range-checked numerically —
 * the bounds are coarse enough that float comparison is safe here even though
 * the arithmetic is not.
 */
const adjustmentPercent = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'must be a decimal number')
  .refine((v) => Number.parseFloat(v) >= -100, 'must be greater than or equal to -100')
  .refine((v) => Number.parseFloat(v) <= 1000, 'must be less than or equal to 1000');

const createSchema = z.object({
  name: z.string().min(1, 'must not be blank'),
  adjustmentPercent,
});

const updateSchema = z.object({
  name: z.string().nullish(),
  adjustmentPercent: adjustmentPercent.nullish(),
  active: z.boolean().nullish(),
});

pricingProfilesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const rows = await db.selectFrom('pricing_profiles').selectAll().orderBy('created_at', 'desc').execute();
    res.json(rows.map(toPricingProfileDto));
  }),
);

pricingProfilesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const row = await db
      .selectFrom('pricing_profiles')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) throw new ResourceNotFoundError('PricingProfile', id);

    res.json(toPricingProfileDto(row));
  }),
);

pricingProfilesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);

    const saved = await db
      .insertInto('pricing_profiles')
      .values({ name: body.name, adjustment_percent: body.adjustmentPercent, active: true })
      .returningAll()
      .executeTakeFirstOrThrow();

    res
      .status(201)
      .location(`/api/v1/pricing-profiles/${saved.id}`)
      .json(toPricingProfileDto(saved));
  }),
);

pricingProfilesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const body = updateSchema.parse(req.body);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (body.name != null) patch.name = body.name;
    if (body.adjustmentPercent != null) patch.adjustment_percent = body.adjustmentPercent;
    if (body.active != null) patch.active = body.active;

    const saved = await db
      .updateTable('pricing_profiles')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!saved) throw new ResourceNotFoundError('PricingProfile', id);

    res.json(toPricingProfileDto(saved));
  }),
);

/**
 * Admin-only via requireAdminForDelete.
 *
 * marketplace_accounts.pricing_profile_id is ON DELETE SET NULL, so deleting a
 * profile silently un-assigns it from every account using it. That is the
 * existing behaviour and the UI relies on it; noted here because it is
 * surprising if you only read this handler.
 */
pricingProfilesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const deleted = await db
      .deleteFrom('pricing_profiles')
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();

    if (!deleted) throw new ResourceNotFoundError('PricingProfile', id);

    res.status(204).end();
  }),
);
