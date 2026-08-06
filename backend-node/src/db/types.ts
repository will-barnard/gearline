/**
 * Kysely table definitions mirroring the Flyway schema at V17.
 *
 * IMPORTANT: this file describes tables it does not own. Flyway (running in the
 * Java service) remains the single source of truth for schema. Do not add
 * migrations here — if a column changes, add a Flyway migration and update this
 * file to match. Keeping ownership in one place is what makes it safe to run
 * both backends against the same database during the strangler cutover.
 *
 * Column names are snake_case exactly as in Postgres. The mapping to the
 * camelCase JSON the frontend expects happens in the DTO mappers, not here, so
 * that the SQL layer stays a faithful description of the database.
 */

import type { ColumnType, Generated, Selectable, Insertable, Updateable } from 'kysely';
import type { RawBuilder } from 'kysely';

/**
 * ── Column type helpers ──────────────────────────────────────────────────────
 *
 * These are written out explicitly rather than wrapped in Kysely's `Generated<>`.
 *
 * `Generated<Timestamp>` — nesting Generated around a ColumnType alias — does
 * not reduce the way you would expect: the update type comes back as the
 * ColumnType itself rather than `Date | string`, so every
 * `.set({ updated_at: new Date() })` fails to typecheck. Declaring the three
 * variants directly avoids the nesting entirely.
 *
 * Read the three ColumnType parameters as <Select, Insert, Update>.
 */

/** TIMESTAMPTZ NOT NULL with a database default — optional on insert. */
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/** TIMESTAMPTZ NULL. */
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;

/**
 * NUMERIC. Selected as a STRING — see the type parser in db/index.ts. Money must
 * never round-trip through a JS float.
 */
type Numeric = ColumnType<string, string | number, string | number>;

/** NUMERIC NULL. */
type NullableNumeric = ColumnType<string | null, string | number | null, string | number | null>;

/**
 * JSONB.
 *
 * Selected as the parsed shape T, but written as a `string` — because every
 * write goes through `toJson()` in db/json.ts, which emits a
 * `RawBuilder<string>` (`'...'::jsonb`). Typing the write side as T instead
 * would reject that helper and invite raw objects, which node-pg would coerce
 * to "[object Object]".
 */
type Json<T> = ColumnType<T, string | RawBuilder<string>, string | RawBuilder<string>>;

/** UUID primary key, defaulted by the database (gen_random_uuid()). */
type GeneratedUuid = ColumnType<string, string | undefined, string>;

/** BIGINT counters (`version`). node-pg returns INT8 as a string. */
type GeneratedBigInt = ColumnType<string, string | number | undefined, string | number>;

/** INTEGER with a database default. */
type GeneratedInt = ColumnType<number, number | undefined, number>;

/** BOOLEAN with a database default. */
type GeneratedBool = ColumnType<boolean, boolean | undefined, boolean>;

export type UserRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export type ProductStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | 'DELETED';

export type ProductCondition =
  | 'MINT'
  | 'EXCELLENT'
  | 'VERY_GOOD'
  | 'GOOD'
  | 'FAIR'
  | 'POOR'
  | 'NEW'
  | 'OPEN_BOX'
  | 'USED'
  | 'FOR_PARTS';

export type MarketplaceType = 'SHOPIFY' | 'EBAY' | 'REVERB';

export type ConnectionStatus =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'TOKEN_EXPIRED'
  | 'ERROR'
  | 'PENDING_OAUTH';

export type ListingStatus =
  | 'PENDING'
  | 'PUBLISHING'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'SOLD'
  | 'DELISTED'
  | 'FAILED'
  | 'NEEDS_REVIEW';

export type OrderStatus =
  | 'IMPORTED'
  | 'ACKNOWLEDGED'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'DISPUTED';

export type SyncJobStatus =
  | 'QUEUED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'DEAD_LETTERED'
  | 'CANCELLED';

export type SyncJobType =
  | 'INVENTORY_SYNC'
  | 'INVENTORY_PUSH_ALL'
  | 'LISTING_PUBLISH'
  | 'LISTING_UPDATE'
  | 'LISTING_DELIST'
  | 'LISTING_BULK_PUBLISH'
  | 'LISTING_BULK_REPRICE'
  | 'ORDER_IMPORT'
  | 'ORDER_IMPORT_ALL'
  | 'SHOPIFY_PRODUCT_SYNC'
  | 'SHOPIFY_INVENTORY_UPDATE'
  | 'SHOPIFY_ORDER_SYNC'
  | 'MARKETPLACE_HEALTH_CHECK';

export type AuditEventType =
  | 'PRODUCT_CREATED'
  | 'PRODUCT_UPDATED'
  | 'PRODUCT_ARCHIVED'
  | 'LISTING_PUBLISHED'
  | 'LISTING_UPDATED'
  | 'LISTING_DELISTED'
  | 'LISTING_FAILED'
  | 'INVENTORY_SYNCED'
  | 'INVENTORY_MISMATCH_DETECTED'
  | 'INVENTORY_CORRECTED'
  | 'ORDER_IMPORTED'
  | 'ORDER_STATUS_UPDATED'
  | 'MARKETPLACE_CONNECTED'
  | 'MARKETPLACE_DISCONNECTED'
  | 'MARKETPLACE_AUTH_REFRESHED'
  | 'MARKETPLACE_ERROR'
  | 'WEBHOOK_RECEIVED'
  | 'WEBHOOK_PROCESSING_FAILED'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'SYNC_JOB_STARTED'
  | 'SYNC_JOB_COMPLETED'
  | 'SYNC_JOB_FAILED'
  | 'SYNC_JOB_DEAD_LETTERED'
  | 'SYNC_JOB_REPLAYED'
  | 'USER_LOGIN'
  | 'USER_LOGOUT'
  | 'USER_CREATED'
  | 'TOKEN_REFRESHED';

// ── Embedded JSON shapes ─────────────────────────────────────────────────────

export interface OrderLineItemJson {
  productId: string | null;
  externalListingId: string | null;
  sku: string | null;
  title: string | null;
  quantity: number | null;
  unitPrice: string | null;
  lineTotal: string | null;
}

/**
 * Field names here MUST match com.gearline.domain.order.BuyerInfo exactly.
 *
 * These are serialised into the orders.buyer_info JSONB column by whichever
 * backend imports the order, and read back by the other one and by the
 * frontend. A renamed field would not error — it would just read as undefined,
 * silently blanking buyer details on the Orders screen for orders imported by
 * the other service.
 */
export interface BuyerInfoJson {
  externalBuyerId?: string | null;
  username?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

/** Matches com.gearline.domain.order.ShippingAddress exactly. */
export interface ShippingAddressJson {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

// ── Tables ───────────────────────────────────────────────────────────────────

export interface UsersTable {
  id: GeneratedUuid;
  email: string;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  role: UserRole;
  active: boolean;
  last_login_at: NullableTimestamp;
  version: GeneratedBigInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ProductsTable {
  id: GeneratedUuid;
  sku: string;
  title: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  condition: ProductCondition;
  price: Numeric;
  quantity: number;
  weight_kg: NullableNumeric;
  dim_length_in: NullableNumeric;
  dim_width_in: NullableNumeric;
  dim_height_in: NullableNumeric;
  serial_number: string | null;
  image_urls: Json<string[]>;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_inventory_item_id: string | null;
  status: ProductStatus;
  /** Optimistic-lock counter. Incremented manually — see db/optimistic.ts. */
  version: GeneratedBigInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  video_url: string | null;
  model: string | null;
  year_made: string | null;
  finish: string | null;
  condition_notes: string | null;
  marketplace_excluded: GeneratedBool;
}

export interface MarketplaceAccountsTable {
  id: GeneratedUuid;
  marketplace_type: MarketplaceType;
  display_name: string;
  external_account_id: string | null;
  external_shop_url: string | null;
  /**
   * TEXT since V10. Holds either an AES-256-GCM ciphertext blob or, when no
   * encryption key is configured, plain JSON. Never read this column directly —
   * go through CredentialEncryptor so both cases are handled.
   */
  encrypted_credentials: string | null;
  sync_settings: Json<Record<string, unknown>>;
  active: boolean;
  connection_status: ConnectionStatus;
  last_sync_at: NullableTimestamp;
  last_error: string | null;
  version: GeneratedBigInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  pricing_profile_id: string | null;
}

export interface MarketplaceListingsTable {
  id: GeneratedUuid;
  product_id: string;
  marketplace_account_id: string;
  marketplace_type: MarketplaceType;
  external_listing_id: string | null;
  listing_status: ListingStatus;
  synced_price: NullableNumeric;
  synced_quantity: number | null;
  last_sync_at: NullableTimestamp;
  last_error: string | null;
  error_count: GeneratedInt;
  listing_overrides: Json<Record<string, unknown>>;
  marketplace_metadata: Json<Record<string, unknown>>;
  version: GeneratedBigInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OrdersTable {
  id: GeneratedUuid;
  external_order_id: string;
  marketplace_account_id: string;
  marketplace_type: MarketplaceType;
  order_status: OrderStatus;
  subtotal: NullableNumeric;
  shipping_total: NullableNumeric;
  tax_total: NullableNumeric;
  total_amount: NullableNumeric;
  currency: string;
  line_items: Json<OrderLineItemJson[]>;
  buyer_info: Json<BuyerInfoJson | null> | null;
  shipping_address: Json<ShippingAddressJson | null> | null;
  marketplace_order_url: string | null;
  imported_at: GeneratedTimestamp;
  fulfilled_at: NullableTimestamp;
  version: GeneratedBigInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  shopify_order_id: string | null;
  tracking_number: string | null;
  tracking_carrier: string | null;
  tracking_url: string | null;
}

export interface SyncJobsTable {
  id: GeneratedUuid;
  job_type: SyncJobType;
  status: SyncJobStatus;
  marketplace_type: MarketplaceType | null;
  marketplace_account_id: string | null;
  product_id: string | null;
  listing_id: string | null;
  retry_count: GeneratedInt;
  max_retries: GeneratedInt;
  next_retry_at: NullableTimestamp;
  payload: Json<Record<string, unknown>>;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  failure_reason: string | null;
  idempotency_key: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AuditEventsTable {
  id: GeneratedUuid;
  event_type: AuditEventType;
  actor_id: string | null;
  actor_name: string | null;
  entity_type: string | null;
  entity_id: string | null;
  marketplace_type: MarketplaceType | null;
  success: boolean;
  error_message: string | null;
  metadata: Json<Record<string, unknown>>;
  created_at: GeneratedTimestamp;
}

export interface PricingProfilesTable {
  id: GeneratedUuid;
  name: string;
  adjustment_percent: Numeric;
  active: boolean;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface Database {
  users: UsersTable;
  products: ProductsTable;
  marketplace_accounts: MarketplaceAccountsTable;
  marketplace_listings: MarketplaceListingsTable;
  orders: OrdersTable;
  sync_jobs: SyncJobsTable;
  audit_events: AuditEventsTable;
  pricing_profiles: PricingProfilesTable;
}

// Convenience row aliases used throughout the service layer.
export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type ProductRow = Selectable<ProductsTable>;
export type NewProduct = Insertable<ProductsTable>;
export type ProductUpdate = Updateable<ProductsTable>;

export type MarketplaceAccountRow = Selectable<MarketplaceAccountsTable>;
export type MarketplaceListingRow = Selectable<MarketplaceListingsTable>;
export type OrderRow = Selectable<OrdersTable>;
export type SyncJobRow = Selectable<SyncJobsTable>;
export type AuditEventRow = Selectable<AuditEventsTable>;
export type PricingProfileRow = Selectable<PricingProfilesTable>;
