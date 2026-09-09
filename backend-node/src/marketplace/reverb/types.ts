/**
 * Reverb API response shapes.
 *
 * All fields optional — Reverb omits rather than nulls, and the Java DTOs were
 * annotated @JsonIgnoreProperties(ignoreUnknown = true). Nothing here should
 * assume a field is present.
 *
 * Reference: https://reverb.com/api#listings
 */

export interface ReverbPrice {
  amount?: string;
  currency?: string;
  amount_cents?: number;
}

export interface ReverbLink {
  href?: string;
}

export interface ReverbLinks {
  self?: ReverbLink;
  web?: ReverbLink;
  manage_url?: ReverbLink;
}

export interface ReverbListingDto {
  id?: string;
  title?: string;
  description?: string;
  make?: string;
  model?: string;
  price?: ReverbPrice;
  inventory?: { total?: number };
  condition?: { slug?: string; display_name?: string };
  categories?: Array<{ uuid?: string; full_name?: string }>;
  photos?: Array<{ full?: string; large?: string; medium?: string; small?: string }>;
  sku?: string;
  slug?: string;
  _links?: ReverbLinks;
  state?: string;
}

export interface ReverbOrderListing {
  id?: string;
  /** Seller SKU — maps back to Product.sku. */
  sku?: string;
  title?: string;
  _links?: ReverbLinks;
}

export interface ReverbShippingAddressDto {
  name?: string;
  street_address?: string;
  extended_address?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country_code?: string;
  phone?: string;
}

export interface ReverbOrderDto {
  /**
   * Reverb returns the identifier as an INTEGER field named "order_id", not
   * "id". The Java DTO needed @JsonProperty("order_id") for this; getting it
   * wrong meant the field was always null and every import hit the
   * external_order_id NOT NULL constraint.
   */
  order_id?: string | number;
  status?: string;
  buyer_name?: string;
  buyer_id?: string;
  buyer_email?: string;
  amount_product?: ReverbPrice;
  amount_tax?: ReverbPrice;
  amount_shipping?: ReverbPrice;
  amount_total?: ReverbPrice;
  created_at?: string;
  shipping_address?: ReverbShippingAddressDto;
  order_bundle_id?: string;
  _links?: ReverbLinks;
  /** Reverb orders are single-item; the sold listing lives here. */
  listing?: ReverbOrderListing;
  quantity?: number;
}

export interface ReverbOrdersResponse {
  orders?: ReverbOrderDto[];
  total?: number;
  current_page?: number;
  total_pages?: number;
}

/**
 * GET /listing_conditions.
 *
 * Reverb has returned this as both a bare array and an object with a
 * `conditions` key depending on the Accept-Version in play, so the parser
 * tolerates either shape rather than assuming one.
 */
export interface ReverbListingCondition {
  uuid?: string;
  slug?: string;
  display_name?: string;
}

export interface ReverbListingConditionsResponse {
  conditions?: ReverbListingCondition[];
  listing_conditions?: ReverbListingCondition[];
}

/**
 * GET /categories/flat.
 *
 * Same tolerance as the conditions parser: the array has arrived both bare and
 * under a `categories` key, and the human-readable name has appeared as both
 * `full_name` ("Parts & Accessories / Cables") and plain `name`.
 */
export interface ReverbCategory {
  uuid?: string;
  name?: string;
  full_name?: string;
  slug?: string;
}

export interface ReverbCategoriesResponse {
  categories?: ReverbCategory[];
}

/** GET /my/listings — the seller's own listings, filterable by sku and state. */
export interface ReverbMyListingsResponse {
  listings?: ReverbListingDto[];
  total?: number;
}

export interface ReverbShopResponse {
  shipping_profiles?: Array<{ id?: string | number; name?: string }>;
}
