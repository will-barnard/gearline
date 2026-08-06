import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { parsePageRequest, toPage } from '../db/page.js';
import type { OrderStatus } from '../db/types.js';
import { toOrderDto } from '../dto/mappers.js';
import { asyncHandler, ResourceNotFoundError } from '../http/errors.js';

/** Port of OrderController. Mounted at /api/v1/orders. Read-only. */
export const ordersRouter: Router = Router();

const uuidSchema = z.string().uuid('must be a valid UUID');

const ORDER_STATUSES: OrderStatus[] = [
  'IMPORTED',
  'ACKNOWLEDGED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
  'DISPUTED',
];

ordersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, size } = parsePageRequest(req.query, { maxSize: 200, defaultSize: 50 });
    const status = req.query.status as OrderStatus | undefined;
    const filterStatus = status && ORDER_STATUSES.includes(status) ? status : null;

    let listQuery = db.selectFrom('orders').selectAll();
    let countQuery = db.selectFrom('orders').select((eb) => eb.fn.countAll<string>().as('count'));

    if (filterStatus) {
      listQuery = listQuery.where('order_status', '=', filterStatus);
      countQuery = countQuery.where('order_status', '=', filterStatus);
    }

    const [rows, countRow] = await Promise.all([
      // Sorted by imported_at, not created_at — matches the Java controller and
      // is what the Orders screen expects (newest import first).
      listQuery.orderBy('imported_at', 'desc').limit(size).offset(page * size).execute(),
      countQuery.executeTakeFirst(),
    ]);

    const total = Number.parseInt(countRow?.count ?? '0', 10);
    res.json(toPage(rows.map(toOrderDto), total, page, size));
  }),
);

ordersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const order = await db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirst();

    if (!order) throw new ResourceNotFoundError('Order', id);

    res.json(toOrderDto(order));
  }),
);
