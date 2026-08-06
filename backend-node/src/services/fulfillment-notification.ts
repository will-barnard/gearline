import { db } from '../db/index.js';
import type { OrderRow } from '../db/types.js';
import { loggerFor } from '../logger.js';
import * as reverbClient from '../marketplace/reverb/client.js';
import * as ebayClient from '../marketplace/ebay/client.js';
import * as audit from './audit.js';

const log = loggerFor('fulfillment-notification');

/**
 * Forwards Shopify shipping details back to the originating marketplace.
 * Port of FulfillmentNotificationService.
 *
 * When a merchant marks an order shipped in Shopify, the buyer on Reverb or
 * eBay needs that tracking number — otherwise they see an unfulfilled order and
 * the marketplace may penalise the seller's metrics.
 *
 * ── The rule that matters: do NOT mark SHIPPED on failure ────────────────────
 *
 * An earlier version of the Java code advanced the order to SHIPPED even when
 * the marketplace API call had just thrown. The result was an order that looked
 * shipped in Gearline while Reverb or eBay knew nothing about it, and the buyer
 * never got a notification — a silent failure with a real customer impact.
 *
 * On failure we persist the tracking fields (so the data is not lost) but leave
 * the status alone. The order visibly remains unshipped, which is the signal
 * that it needs attention.
 */

export interface FulfillmentDetails {
  shopifyOrderId: string;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  trackingUrl: string | null;
  /** Actual ship date from the Shopify webhook. Falls back to now when absent. */
  fulfilledAt: Date | null;
}

export async function notifyMarketplace(details: FulfillmentDetails): Promise<void> {
  const { shopifyOrderId, trackingNumber, trackingCarrier, trackingUrl, fulfilledAt } = details;

  if (!shopifyOrderId || shopifyOrderId.trim() === '') {
    log.warn('fulfillments/create received with no order_id — ignoring');
    return;
  }

  const order = await db
    .selectFrom('orders')
    .selectAll()
    .where('shopify_order_id', '=', shopifyOrderId)
    .executeTakeFirst();

  if (!order) {
    // Almost always a native Shopify sale that Gearline never mirrored.
    log.debug({ shopifyOrderId }, 'No Gearline order for this Shopify order — skipping');
    return;
  }

  // Idempotency: Shopify redelivers, and a second notification would send the
  // buyer a duplicate shipping email.
  if (order.order_status === 'SHIPPED') {
    log.debug({ orderId: order.id }, 'Order already SHIPPED — skipping duplicate fulfillment webhook');
    return;
  }

  const shippedDate = fulfilledAt ?? new Date();

  // A Shopify-native order has no external marketplace to tell.
  if (order.marketplace_type === 'SHOPIFY') {
    log.debug({ orderId: order.id }, 'Shopify-native order — no external marketplace to notify');
    await markShipped(order, details, shippedDate);
    return;
  }

  const account = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('id', '=', order.marketplace_account_id)
    .executeTakeFirst();

  if (!account) {
    log.error(
      { orderId: order.id, accountId: order.marketplace_account_id },
      'Cannot notify marketplace — account not found',
    );
    return;
  }

  try {
    switch (order.marketplace_type) {
      case 'REVERB':
        log.info(
          { orderId: order.external_order_id, trackingCarrier, trackingNumber },
          'Notifying Reverb of shipment',
        );
        await reverbClient.markOrderShipped(
          account,
          order.external_order_id,
          trackingNumber,
          trackingCarrier,
        );
        break;

      case 'EBAY': {
        /**
         * eBay requires the specific lineItemIds being fulfilled. Those were
         * captured into OrderLineItem.externalListingId at import time; an
         * order imported without them cannot be fulfilled through the API.
         */
        const lineItems = (order.line_items ?? [])
          .filter((li) => li.externalListingId !== null)
          .map((li) => ({
            lineItemId: li.externalListingId as string,
            quantity: li.quantity ?? 1,
          }));

        if (lineItems.length === 0) {
          // Throwing routes into the catch: tracking is saved, the order stays
          // unshipped, and the operator can fulfil it manually in Seller Hub.
          throw new Error(
            `eBay order ${order.external_order_id} has no line items with an eBay lineItemId — ` +
              'cannot build the fulfilment payload',
          );
        }

        log.info(
          { orderId: order.external_order_id, trackingCarrier, trackingNumber, shippedDate },
          'Notifying eBay of shipment',
        );

        await ebayClient.markOrderShipped(
          account,
          order.external_order_id,
          lineItems,
          trackingNumber,
          trackingCarrier,
          shippedDate.toISOString(),
        );
        break;
      }

      default:
        log.warn({ marketplaceType: order.marketplace_type }, 'No fulfilment handler for marketplace');
        return;
    }

    await markShipped(order, details, shippedDate);

    log.info(
      { marketplace: order.marketplace_type, orderId: order.external_order_id, trackingNumber },
      'Notified marketplace of shipment',
    );

    audit.recordMarketplaceEvent(
      'ORDER_STATUS_UPDATED',
      order.marketplace_type,
      null,
      'Order',
      order.id,
      true,
      null,
      { status: 'SHIPPED', trackingNumber: trackingNumber ?? '' },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.error(
      { err, marketplace: order.marketplace_type, orderId: order.external_order_id },
      'Failed to notify marketplace of shipment — order NOT marked SHIPPED',
    );

    // Keep the tracking data, leave the status alone. See the class note.
    await saveTrackingOnly(order, details);

    audit.recordMarketplaceEvent(
      'ORDER_STATUS_UPDATED',
      order.marketplace_type,
      null,
      'Order',
      order.id,
      false,
      message,
      { trackingNumber: trackingNumber ?? '' },
    );
  }
}

/** Marks SHIPPED and stores every tracking field. */
async function markShipped(
  order: OrderRow,
  details: FulfillmentDetails,
  fulfilledAt: Date,
): Promise<void> {
  await db
    .updateTable('orders')
    .set({
      tracking_number: details.trackingNumber,
      tracking_carrier: details.trackingCarrier,
      tracking_url: details.trackingUrl,
      order_status: 'SHIPPED',
      fulfilled_at: fulfilledAt,
      updated_at: new Date(),
    })
    .where('id', '=', order.id)
    .execute();
}

/**
 * Stores tracking WITHOUT advancing the status.
 *
 * Used when the marketplace call failed. fulfilled_at is deliberately left
 * unset too — an order is not fulfilled until the marketplace has been told.
 */
async function saveTrackingOnly(order: OrderRow, details: FulfillmentDetails): Promise<void> {
  await db
    .updateTable('orders')
    .set({
      tracking_number: details.trackingNumber,
      tracking_carrier: details.trackingCarrier,
      tracking_url: details.trackingUrl,
      updated_at: new Date(),
    })
    .where('id', '=', order.id)
    .execute();
}
