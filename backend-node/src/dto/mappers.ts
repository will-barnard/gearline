/**
 * Row → DTO mappers.
 *
 * These reproduce the Java record DTOs field-for-field. The field NAMES and
 * their null/absent behaviour are a public contract with the Vue frontend, so
 * changes here are breaking changes even though nothing in this repo references
 * them by name.
 *
 * Two Jackson behaviours from application.yml that had to be reproduced:
 *
 *   write-dates-as-timestamps: false
 *       Instants serialise as ISO-8601 strings, not epoch millis.
 *       `new Date().toISOString()` matches.
 *
 *   default-property-inclusion: non_null
 *       Null fields are OMITTED from the JSON entirely rather than sent as
 *       `"field": null`. `stripNulls` below reproduces that. It matters for
 *       optional fields the frontend tests with `if (x)` versus `if ('x' in y)`.
 */

import type {
  AuditEventRow,
  MarketplaceAccountRow,
  MarketplaceListingRow,
  OrderRow,
  PricingProfileRow,
  ProductRow,
  SyncJobRow,
  UserRow,
} from '../db/types.js';

/** Reproduces Jackson's non_null inclusion. Shallow by design — DTOs are flat. */
export function stripNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

// ── Product ──────────────────────────────────────────────────────────────────

export function toProductDto(p: ProductRow) {
  return stripNulls({
    id: p.id,
    sku: p.sku,
    title: p.title,
    description: p.description,
    brand: p.brand,
    category: p.category,
    model: p.model,
    yearMade: p.year_made,
    finish: p.finish,
    condition: p.condition,
    conditionNotes: p.condition_notes,
    price: p.price,
    quantity: p.quantity,
    weightKg: p.weight_kg,
    dimLengthIn: p.dim_length_in,
    dimWidthIn: p.dim_width_in,
    dimHeightIn: p.dim_height_in,
    serialNumber: p.serial_number,
    imageUrls: p.image_urls ?? [],
    videoUrl: p.video_url,
    status: p.status,
    // Primitive boolean in Java — always present even when false, so it must
    // survive stripNulls. false is not null, so it does.
    marketplaceExcluded: p.marketplace_excluded,
    shopifyProductId: p.shopify_product_id,
    createdAt: iso(p.created_at),
    updatedAt: iso(p.updated_at),
  });
}

// ── Listing ──────────────────────────────────────────────────────────────────

/**
 * ListingDto denormalises four product fields. The Java version passes a
 * possibly-null Product and emits nulls for all four when the product is
 * missing; `product` is optional here for the same reason.
 */
export function toListingDto(l: MarketplaceListingRow, product?: ProductRow | null) {
  return stripNulls({
    id: l.id,
    productId: l.product_id,
    productTitle: product?.title ?? null,
    productSku: product?.sku ?? null,
    productPrice: product?.price ?? null,
    productQuantity: product?.quantity ?? null,
    marketplaceAccountId: l.marketplace_account_id,
    marketplaceType: l.marketplace_type,
    externalListingId: l.external_listing_id,
    listingStatus: l.listing_status,
    syncedPrice: l.synced_price,
    syncedQuantity: l.synced_quantity,
    lastSyncAt: iso(l.last_sync_at),
    lastError: l.last_error,
    errorCount: l.error_count,
    listingOverrides: l.listing_overrides ?? {},
    marketplaceMetadata: l.marketplace_metadata ?? {},
    createdAt: iso(l.created_at),
    updatedAt: iso(l.updated_at),
  });
}

// ── Order ────────────────────────────────────────────────────────────────────

export function toOrderDto(o: OrderRow) {
  return stripNulls({
    id: o.id,
    externalOrderId: o.external_order_id,
    marketplaceAccountId: o.marketplace_account_id,
    marketplaceType: o.marketplace_type,
    orderStatus: o.order_status,
    lineItems: o.line_items ?? [],
    subtotal: o.subtotal,
    shippingTotal: o.shipping_total,
    taxTotal: o.tax_total,
    totalAmount: o.total_amount,
    currency: o.currency,
    buyerInfo: o.buyer_info,
    shippingAddress: o.shipping_address,
    marketplaceOrderUrl: o.marketplace_order_url,
    importedAt: iso(o.imported_at),
    createdAt: iso(o.created_at),
  });
}

// ── Sync job ─────────────────────────────────────────────────────────────────

export function toSyncJobDto(j: SyncJobRow) {
  return stripNulls({
    id: j.id,
    jobType: j.job_type,
    status: j.status,
    marketplaceType: j.marketplace_type,
    marketplaceAccountId: j.marketplace_account_id,
    productId: j.product_id,
    listingId: j.listing_id,
    retryCount: j.retry_count,
    maxRetries: j.max_retries,
    nextRetryAt: iso(j.next_retry_at),
    payload: j.payload ?? {},
    startedAt: iso(j.started_at),
    completedAt: iso(j.completed_at),
    failureReason: j.failure_reason,
    idempotencyKey: j.idempotency_key,
    createdAt: iso(j.created_at),
  });
}

// ── Marketplace account ──────────────────────────────────────────────────────

function stringSetting(settings: Record<string, unknown> | null, key: string): string | null {
  const raw = settings?.[key];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * Note what is NOT here: encrypted_credentials. The Java DTO omits it too.
 * Marketplace OAuth tokens must never reach the browser, so the omission is a
 * security control, not an oversight — do not add it for debugging convenience.
 */
export function toMarketplaceAccountDto(
  a: MarketplaceAccountRow,
  profile?: PricingProfileRow | null,
) {
  const settings = a.sync_settings ?? {};

  const rawTags = settings['excluded_tags'];
  const excludedTags = Array.isArray(rawTags) ? rawTags.map((t) => String(t)) : [];

  return stripNulls({
    id: a.id,
    marketplaceType: a.marketplace_type,
    displayName: a.display_name,
    externalAccountId: a.external_account_id,
    externalShopUrl: a.external_shop_url,
    active: a.active,
    connectionStatus: a.connection_status,
    lastSyncAt: iso(a.last_sync_at),
    lastError: a.last_error,
    createdAt: iso(a.created_at),
    pricingProfileId: profile?.id ?? null,
    pricingProfileName: profile?.name ?? null,
    // Always an array, never null — the frontend iterates it unguarded.
    excludedTags,
    descriptionSuffix: stringSetting(settings, 'description_suffix'),
    ebayMerchantLocationKey: stringSetting(settings, 'ebay_merchant_location_key'),
    ebayFulfillmentPolicyId: stringSetting(settings, 'ebay_fulfillment_policy_id'),
    ebayReturnPolicyId: stringSetting(settings, 'ebay_return_policy_id'),
  });
}

// ── Audit event ──────────────────────────────────────────────────────────────

export function toAuditEventDto(e: AuditEventRow) {
  return stripNulls({
    id: e.id,
    eventType: e.event_type,
    actorId: e.actor_id,
    actorName: e.actor_name,
    entityType: e.entity_type,
    entityId: e.entity_id,
    marketplaceType: e.marketplace_type,
    success: e.success,
    errorMessage: e.error_message,
    metadata: e.metadata ?? {},
    createdAt: iso(e.created_at),
  });
}

// ── User ─────────────────────────────────────────────────────────────────────

export function toUserDto(u: UserRow) {
  return stripNulls({
    id: u.id,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    role: u.role,
    active: u.active,
    lastLoginAt: iso(u.last_login_at),
    createdAt: iso(u.created_at),
  });
}

export function toUserProfileResponse(u: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
}) {
  return stripNulls({
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role,
  });
}

// ── Pricing profile ──────────────────────────────────────────────────────────

export function toPricingProfileDto(p: PricingProfileRow) {
  return stripNulls({
    id: p.id,
    name: p.name,
    adjustmentPercent: p.adjustment_percent,
    active: p.active,
    createdAt: iso(p.created_at),
    updatedAt: iso(p.updated_at),
  });
}
