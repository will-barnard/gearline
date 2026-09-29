import { timingSafeEqual } from 'node:crypto';

import { db } from '../db/index.js';
import { jsonMerge } from '../db/json.js';
import type { MarketplaceAccountRow, OrderStatus } from '../db/types.js';
import { loggerFor } from '../logger.js';
import type { GxWebhookEvent } from '../marketplace/gear-exchange/types.js';
import { enqueue } from '../queue/sync-job-producer.js';
import { readCredentials } from '../security/credential-encryptor.js';
import * as audit from './audit.js';

const log = loggerFor('gx-webhooks');

/**
 * Gear Exchange webhook handling.
 *
 * ── Authentication ───────────────────────────────────────────────────────────
 *
 * GX does not sign payloads. Instead the seller enters a bearer token in the
 * webhook form and GX sends it back on every call. Gearline generates that
 * token when the account is connected (credentials.webhook_token) and shows it
 * on the Marketplaces page. The payload does not say which seller it is for,
 * so the token is also how the account is identified.
 *
 * ── What the events do ───────────────────────────────────────────────────────
 *
 * Webhooks are a fast path, not the source of truth. Order polling still runs
 * for Gear Exchange, so a missed or failed webhook costs at most one polling
 * interval. That is why a sale does not import the order inline: it enqueues
 * the same ORDER_IMPORT job the rest of the system uses, which fetches the full
 * order from the API and goes through the normal import pipeline (dedup,
 * inventory deduction, Shopify mirror).
 */

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The account whose webhook token was presented, or null. */
export async function accountForWebhookToken(
  authorizationHeader: string | undefined,
): Promise<MarketplaceAccountRow | null> {
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader?.trim() ?? '');
  if (!match) return null;
  const presented = match[1]!.trim();
  if (presented === '') return null;

  const accounts = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('marketplace_type', '=', 'GEAR_EXCHANGE')
    .execute();

  for (const account of accounts) {
    const expected = readCredentials(account.encrypted_credentials)['webhook_token'];
    if (expected && tokensMatch(presented, expected)) return account;
  }

  return null;
}

/** GX order status → Gearline order status, for the statuses that map cleanly. */
const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  'tracking provided': 'SHIPPED',
  'in transit': 'SHIPPED',
  delivered: 'DELIVERED',
  'picked up': 'DELIVERED',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
  'refund completed': 'REFUNDED',
  'problem reported': 'DISPUTED',
};

/** Statuses that mean a new sale Gearline should import. */
const SALE_STATUSES = new Set(['awaiting shipping']);

function idString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

async function enqueueOrderImport(account: MarketplaceAccountRow, orderId: string): Promise<void> {
  await enqueue({
    jobType: 'ORDER_IMPORT',
    marketplaceType: 'GEAR_EXCHANGE',
    marketplaceAccountId: account.id,
    payload: { externalOrderId: orderId, source: 'gx_webhook' },
    // A sale fires both ListingStatusChange/Sold and OrderStatusChange/Awaiting
    // Shipping. One import is enough.
    idempotencyKey: `gx-order-import-${account.id}-${orderId}`,
  });
}

async function handleOrderEvent(account: MarketplaceAccountRow, event: GxWebhookEvent): Promise<void> {
  const status = String(event.data?.status ?? '').trim().toLowerCase();
  const orderId = idString(event.data?.orderId);

  if (!orderId) {
    log.warn({ status }, 'Gear Exchange order event without an orderId — ignored');
    return;
  }

  if (SALE_STATUSES.has(status)) {
    await enqueueOrderImport(account, orderId);
    return;
  }

  const mapped = ORDER_STATUS_MAP[status];
  if (!mapped) {
    log.debug({ status, orderId }, 'Gear Exchange order status with no Gearline equivalent — audit only');
    return;
  }

  /**
   * Status changes only move an order Gearline already has. A cancellation
   * does NOT put stock back: the item may never have been shipped, or may be
   * on its way back as a return, and only the operator knows which. It shows
   * up on the order so they can decide.
   */
  const updated = await db
    .updateTable('orders')
    .set({ order_status: mapped, updated_at: new Date() })
    .where('marketplace_type', '=', 'GEAR_EXCHANGE')
    .where('external_order_id', '=', orderId)
    .returning('id')
    .executeTakeFirst();

  log.info({ orderId, status, mapped, found: !!updated }, 'Gear Exchange order status change');
}

async function handleListingEvent(account: MarketplaceAccountRow, event: GxWebhookEvent): Promise<void> {
  const status = String(event.data?.status ?? '').trim().toLowerCase();
  const gxListingId = idString(event.listingId);

  if (status === 'sold') {
    const orderId = idString(event.data?.orderId);
    if (orderId) await enqueueOrderImport(account, orderId);
    return;
  }

  if (!gxListingId) return;

  const row = await db
    .selectFrom('marketplace_listings')
    .selectAll()
    .where('marketplace_account_id', '=', account.id)
    .where('external_listing_id', '=', gxListingId)
    .executeTakeFirst();

  if (!row) {
    log.debug({ gxListingId, status }, 'Gear Exchange listing event for a listing Gearline does not track');
    return;
  }

  switch (status) {
    case 'published':
      await db
        .updateTable('marketplace_listings')
        .set({
          marketplace_metadata: jsonMerge('marketplace_metadata', {
            gx_status: 'published',
            images_processing: false,
          }),
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
      break;

    case 'deleted':
      /**
       * Deleted on Gear Exchange by hand. The row must stop claiming a live
       * listing, and the dead ID must go so the next publish creates a fresh
       * one instead of updating something that no longer exists.
       */
      await db
        .updateTable('marketplace_listings')
        .set({
          listing_status: row.listing_status === 'SOLD' ? 'SOLD' : 'INACTIVE',
          external_listing_id: null,
          last_error: 'Deleted on Gear Exchange',
          marketplace_metadata: jsonMerge('marketplace_metadata', { gx_status: 'deleted', gx_listing_id: null }),
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
      log.warn({ gxListingId, listingId: row.id }, 'Gear Exchange listing was deleted on Gear Exchange');
      break;

    case 'category updated':
      // Sweetwater staff can recategorise a listing. Recorded so the operator
      // can see it; the next update would otherwise quietly move it back.
      await db
        .updateTable('marketplace_listings')
        .set({
          marketplace_metadata: jsonMerge('marketplace_metadata', {
            gx_category_id: idString(event.data?.categoryId),
            gx_category_changed_by_gx: true,
          }),
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
      break;

    default:
      log.debug({ gxListingId, status }, 'Unhandled Gear Exchange listing status');
  }
}

/** Never throws — the caller has already answered GX. */
export async function processWebhook(account: MarketplaceAccountRow, event: GxWebhookEvent): Promise<void> {
  try {
    audit.recordMarketplaceEvent('WEBHOOK_RECEIVED', 'GEAR_EXCHANGE', null, 'Webhook', String(event.eventType ?? 'unknown'), true, null, {
      eventType: String(event.eventType ?? ''),
      status: String(event.data?.status ?? ''),
      listingId: idString(event.listingId) ?? '',
      orderId: idString(event.data?.orderId) ?? '',
    });

    if (event.eventType === 'OrderStatusChange') {
      await handleOrderEvent(account, event);
    } else if (event.eventType === 'ListingStatusChange') {
      await handleListingEvent(account, event);
    } else {
      log.info({ eventType: event.eventType }, 'Unknown Gear Exchange webhook event type');
    }
  } catch (err) {
    log.error({ err, eventType: event.eventType }, 'Gear Exchange webhook processing failed');
    audit.recordMarketplaceEvent(
      'WEBHOOK_PROCESSING_FAILED',
      'GEAR_EXCHANGE',
      null,
      'Webhook',
      String(event.eventType ?? 'unknown'),
      false,
      err instanceof Error ? err.message : String(err),
      {},
    );
  }
}
