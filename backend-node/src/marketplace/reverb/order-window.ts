import type { ImportedOrder } from '../types.js';

/**
 * Decides which orders from Reverb's order list are worth importing.
 *
 * ── Why created_at alone is not enough ───────────────────────────────────────
 *
 * Reverb's `created_at` is when the ORDER was created, not when it was paid.
 * An accepted offer creates the order immediately, but the buyer can take a day
 * to pay. By then the polling watermark (`last_sync_at`) is long past
 * `created_at`, so a check of `createdAt >= watermark` throws the order away —
 * permanently, because every later poll has an even newer watermark.
 * (Order 26545736: offer accepted the night of Sep 28, paid ~20h later.)
 *
 * So the connector looks back over a longer RESCAN window than the watermark
 * and imports anything in it that it has not seen before. Deduplication against
 * the orders table makes that cheap — known orders cost no extra API calls.
 */

const DAY_MS = 86_400_000;

/**
 * Statuses that mean money has cleared. Only these are imported when an order
 * turns up BEHIND the watermark.
 *
 * Orders newer than the watermark keep the original behaviour (no status gate).
 * Behind the watermark we are scanning history, so we must not resurrect an
 * order that was cancelled or refunded, or is still waiting on payment or fraud
 * review — importing one deducts inventory and delists the item elsewhere.
 * `payment_pending` and `pending_review` are deliberately absent: they become
 * `paid` later and the next poll picks them up.
 */
export const RESCAN_IMPORTABLE_STATUSES: ReadonlySet<string> = new Set([
  'paid',
  'shipped',
  'picked_up',
  'received',
]);

/** Start of the scan window: the watermark, or the rescan horizon if that is older. */
export function rescanWindowStartMs(sinceMs: number, nowMs: number, rescanDays: number): number {
  return Math.min(sinceMs, nowMs - rescanDays * DAY_MS);
}

function createdAtMs(order: ImportedOrder): number | null {
  if (!order.createdAt) return null;
  const t = new Date(order.createdAt).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Is the order inside the scan window? Used to decide when to stop paginating.
 * Unparseable dates count as inside, to fail safe.
 */
export function isInRescanWindow(order: ImportedOrder, windowStartMs: number): boolean {
  const t = createdAtMs(order);
  return t === null || t >= windowStartMs;
}

/**
 * Should this order be considered for import (before the already-imported check)?
 *
 *  - newer than the watermark, or undated: yes, as before
 *  - older than the watermark but inside the rescan window: only if paid
 *  - older than the window: no
 */
export function isImportCandidate(
  order: ImportedOrder,
  sinceMs: number,
  windowStartMs: number,
): boolean {
  const t = createdAtMs(order);
  if (t === null || t >= sinceMs) return true;
  if (t < windowStartMs) return false;
  return RESCAN_IMPORTABLE_STATUSES.has((order.marketplaceStatus ?? '').toLowerCase());
}

/** True when the order was found behind the watermark — i.e. it was paid late. */
export function isBehindWatermark(order: ImportedOrder, sinceMs: number): boolean {
  const t = createdAtMs(order);
  return t !== null && t < sinceMs;
}
