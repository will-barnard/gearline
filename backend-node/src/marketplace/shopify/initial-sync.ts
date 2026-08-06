import type { MarketplaceAccountRow } from '../../db/types.js';
import { loggerFor } from '../../logger.js';
import * as client from './client.js';
import { process as processWebhook } from './webhook-processor.js';

const log = loggerFor('shopify-initial-sync');

/**
 * One-off bulk import of a store's existing products.
 * Port of ShopifyInitialSyncService.
 *
 * Webhooks only fire for FUTURE events, so every product that already existed
 * when the store was connected would otherwise never reach Gearline. This pages
 * the products list API and feeds each one through the same
 * `products/create` path a webhook would take — which is already idempotent, so
 * re-running is safe and is the intended recovery for a partial failure.
 *
 * Note it re-serialises each product to a Buffer so the processor parses it
 * exactly as it would a real webhook body. Slightly wasteful, but it means
 * there is ONE code path for product import rather than two that can drift.
 */
export async function syncAllProducts(account: MarketplaceAccountRow): Promise<void> {
  const shopDomain = account.external_shop_url ?? account.external_account_id ?? 'unknown';

  log.info({ shopDomain }, 'Starting initial Shopify product sync');

  let processed = 0;
  let errors = 0;
  let pageInfo: string | null = null;
  let pages = 0;

  /**
   * Hard cap on pages. At 250 products per page this allows 250k products,
   * far beyond any realistic catalogue — it exists purely so a malformed
   * cursor response cannot spin forever.
   */
  const MAX_PAGES = 1000;

  try {
    do {
      const page = await client.fetchProducts(account, pageInfo);
      pages++;

      for (const product of page.products) {
        try {
          const bytes = Buffer.from(JSON.stringify(product), 'utf8');
          await processWebhook('products/create', shopDomain, bytes);
          processed++;
        } catch (err) {
          errors++;
          // One bad product must not abort the whole catalogue import.
          const id =
            typeof product === 'object' && product !== null
              ? String((product as Record<string, unknown>)['id'] ?? '?')
              : '?';
          log.error({ err, productId: id, shopDomain }, 'Error importing product during initial sync');
        }
      }

      log.info(
        { pageSize: page.products.length, processed, shopDomain },
        'Synced a page of Shopify products',
      );

      pageInfo = page.nextPageInfo;
    } while (pageInfo !== null && pages < MAX_PAGES);

    if (pages >= MAX_PAGES) {
      log.warn({ shopDomain, MAX_PAGES }, 'Initial sync hit the page cap — catalogue may be truncated');
    }
  } catch (err) {
    log.error({ err, shopDomain }, 'Initial product sync failed');
  }

  log.info({ shopDomain, processed, errors }, 'Initial Shopify product sync complete');
}
