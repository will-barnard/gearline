import { config } from '../config.js';
import { db } from '../db/index.js';
import type { MarketplaceAccountRow, MarketplaceType } from '../db/types.js';
import { loggerFor } from '../logger.js';
import { getConnector, hasConnector } from '../marketplace/registry.js';
import { importOrder } from './order-import.js';

const log = loggerFor('order-polling');

/**
 * Polls Reverb and eBay for new orders. Port of OrderPollingScheduler.
 *
 * ── Why poll at all ──────────────────────────────────────────────────────────
 *
 * Shopify pushes order webhooks. Reverb and eBay do not push order events to
 * third-party apps, so the only way to discover a sale is to ask.
 *
 * SHOPIFY IS DELIBERATELY EXCLUDED. Polling it would duplicate every
 * webhook-delivered order.
 */

const POLLED_TYPES: MarketplaceType[] = ['REVERB', 'EBAY'];

/**
 * Lookback cap for accounts that have been polled before.
 *
 * After a long outage we would otherwise ask for every order since the app was
 * last up. Capping at 72h bounds the recovery batch; anything older has to be
 * imported manually, which is the right trade for an outage that long.
 */
const MAX_LOOKBACK_HOURS = 72;

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function pollAllAccounts(): Promise<void> {
  // Skip if the previous cycle is still going — a slow marketplace API must not
  // cause overlapping polls that import the same window twice.
  if (running) {
    log.debug('Previous polling cycle still running — skipping this tick');
    return;
  }

  running = true;
  log.debug('Order polling cycle starting');

  try {
    for (const type of POLLED_TYPES) {
      if (!hasConnector(type)) {
        log.debug({ type }, 'No connector registered — skipping');
        continue;
      }

      const accounts = await db
        .selectFrom('marketplace_accounts')
        .selectAll()
        .where('marketplace_type', '=', type)
        .where('active', '=', true)
        .execute();

      // Each account is polled independently so one expired token cannot
      // block the others.
      for (const account of accounts) {
        await pollAccount(account);
      }
    }
  } catch (err) {
    log.error({ err }, 'Order polling cycle failed');
  } finally {
    running = false;
    log.debug('Order polling cycle complete');
  }
}

async function pollAccount(account: MarketplaceAccountRow): Promise<void> {
  const type = account.marketplace_type;

  try {
    const connector = getConnector(type);

    /**
     * ── First-run guard ────────────────────────────────────────────────────
     *
     * A null lastSyncAt means the account was just connected (or the database
     * was rebuilt). Stamp it to NOW and import nothing.
     *
     * This is the difference between a fresh deploy being a no-op and it
     * importing the entire order history — which would then deduct inventory
     * for every historical sale and delist the whole catalogue.
     */
    if (account.last_sync_at === null) {
      log.info(
        { type, accountId: account.id },
        'First poll — initialising lastSyncAt to now, skipping historical import',
      );
      await updateLastSyncAt(account.id);
      return;
    }

    const floor = new Date(Date.now() - MAX_LOOKBACK_HOURS * 3_600_000);
    const since = account.last_sync_at > floor ? account.last_sync_at : floor;

    log.info({ type, accountId: account.id, since }, 'Polling for orders');

    const orders = await connector.importOrders(account, since);

    if (orders.length === 0) {
      log.debug({ type, accountId: account.id }, 'No new orders');
      await updateLastSyncAt(account.id);
      return;
    }

    log.info({ count: orders.length, type, accountId: account.id }, 'Found new orders');

    let imported = 0;
    let failed = 0;

    for (const order of orders) {
      try {
        const saved = await importOrder(order, account);
        if (saved) imported++;
      } catch (err) {
        failed++;
        log.error(
          { err, type, externalOrderId: order.externalOrderId },
          'Failed to import order',
        );
      }
    }

    log.info({ imported, total: orders.length, failed, type, accountId: account.id }, 'Import complete');

    /**
     * Only advance lastSyncAt when EVERY order imported cleanly.
     *
     * Advancing past a failed order would skip that sale permanently — no
     * inventory deduction, no Shopify mirror, no record. Holding the watermark
     * means the next cycle retries the same window. Already-imported orders in
     * that window are deduplicated by (marketplace_type, external_order_id), so
     * the retry is cheap and safe.
     *
     * The trade-off: a permanently malformed order re-fails every cycle until
     * someone intervenes. That is noisy by design — a stuck order should be
     * visible, not silently dropped.
     */
    if (failed > 0) {
      log.warn(
        { failed, type, accountId: account.id },
        'Some orders failed — NOT advancing lastSyncAt; they will be retried next cycle',
      );
      return;
    }

    await updateLastSyncAt(account.id);
  } catch (err) {
    // No lastSyncAt update on failure — the next poll re-attempts the same window.
    log.error({ err, type, accountId: account.id }, 'Order polling failed for account');
  }
}

/**
 * Targeted UPDATE rather than a full row write.
 *
 * The auth provider may have refreshed credentials mid-poll, bumping `version`
 * and making the account row we hold stale. Writing only this column sidesteps
 * the optimistic-lock check entirely — lastSyncAt is the poller's to own, and
 * credentials belong to the auth provider.
 */
async function updateLastSyncAt(accountId: string): Promise<void> {
  await db
    .updateTable('marketplace_accounts')
    .set({ last_sync_at: new Date() })
    .where('id', '=', accountId)
    .execute();
}

export function startOrderPolling(): void {
  if (timer) return;

  const { intervalMs, initialDelayMs } = config.orderPolling;

  setTimeout(() => {
    void pollAllAccounts();
    timer = setInterval(() => void pollAllAccounts(), intervalMs);
  }, initialDelayMs).unref();

  log.info({ intervalMs, initialDelayMs }, 'Order polling scheduler started');
}

export function stopOrderPolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info('Order polling scheduler stopped');
  }
}
