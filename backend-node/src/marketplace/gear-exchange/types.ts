/**
 * Gear Exchange (Sweetwater) public API shapes.
 *
 * Reference: https://www.sweetwater.com/used/help/api/getting-started
 * Read against the docs on 2026-09-29.
 *
 * Everything is optional. The docs show examples rather than schemas, and a
 * few examples disagree with each other on types (categoryId is a string in the
 * create request and a number in every response; madeYear likewise). Reading
 * defensively costs nothing and keeps a type drift from becoming a crash.
 */

/** draft = never published OR deactivated. There is no separate "inactive". */
export type GxListingStatus = 'draft' | 'pending_admin_review' | 'published' | 'sold' | string;

export interface GxListingDto {
  id?: number | string;
  status?: GxListingStatus;
  brand?: string;
  categoryId?: number | string;
  /** Display NAME ("Mint"), not the conditionId that was sent. */
  condition?: string;
  imageUrls?: string[];
  videoUrl?: string | null;
  title?: string;
  titleWithBrand?: string;
  description?: string;
  price?: string;
  previousPrice?: string;
  onSale?: boolean;
  currentSalePrice?: string | null;
  acceptsOffers?: boolean;
  minOffer?: string | null;
  optedInToSales?: boolean;
  sku?: string | null;
  serialNumber?: string | null;
  localPickupAllowed?: boolean;
  shippingAllowed?: boolean;
  payoutMethod?: string;
  returnPolicy?: number;
  /** Our own identifier, round-tripped. Gearline stores its product UUID here. */
  productId?: string | null;
  publishedAt?: string | null;
  deactivatedAt?: string | null;
}

/** Create and update wrap the listing; publish and deactivate return it bare. */
export interface GxListingEnvelope {
  message?: string;
  listing?: GxListingDto;
}

export interface GxImageDto {
  id?: number;
  url?: string;
  /** The source URL we supplied — how images are matched for reordering. */
  public_url?: string | null;
}

export interface GxAddressDto {
  addressLineOne?: string;
  addressLineTwo?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  firstName?: string;
  lastName?: string;
}

export interface GxOrderDto {
  orderId?: number | string;
  listingId?: number | string;
  productId?: string | null;
  /** "Awaiting Shipping", "Canceled", "Delivered", ... see order-mapper.ts. */
  status?: string;
  listedPrice?: string;
  /** Differs from listedPrice when an offer was accepted or a sale applied. */
  soldPrice?: string;
  shippingAmount?: string;
  taxAmount?: string;
  totalAmount?: string;
  soldAt?: string;
  shippingInfo?: {
    local_pickup?: boolean;
    shipping_provider?: string | null;
    tracking_number?: string | null;
    shipped_at?: string | null;
    in_transit_at?: string | null;
    delivered_at?: string | null;
    ship_to_address?: GxAddressDto;
  };
  buyerInfo?: {
    buyer_first_name?: string;
    buyer_last_name?: string;
    buyer_id?: number | string;
  };
}

/**
 * A generic {id, name} option — categories, conditions, return policies,
 * payout methods, shipping providers. The docs name the endpoints but do not
 * show their responses, so the client normalises whatever comes back into this.
 */
export interface GxOption {
  id: string;
  name: string;
}

/** Webhook payload — identical envelope for listing and order events. */
export interface GxWebhookEvent {
  listingId?: number | string;
  productId?: string | null;
  eventType?: 'ListingStatusChange' | 'OrderStatusChange' | string;
  data?: {
    status?: string;
    orderId?: number | string;
    previousCategoryId?: number | string;
    categoryId?: number | string;
    [key: string]: unknown;
  };
}
