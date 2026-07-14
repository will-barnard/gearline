package com.gearline.marketplace.ebay.client;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.marketplace.MarketplaceAccount;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.util.List;
import java.util.Map;

/**
 * Low-level HTTP client for the eBay Sell APIs.
 *
 * Covers:
 *   Inventory API v1  — https://api.ebay.com/sell/inventory/v1
 *   Fulfillment API v1 — https://api.ebay.com/sell/fulfillment/v1
 *
 * Auth: Bearer access token from {@code MarketplaceAccount.encryptedCredentials["access_token"]}.
 *
 * All methods throw {@link EbayApiException} on 4xx/5xx responses.
 * Callers are responsible for token refresh (via EbayAuthProvider) on 401.
 */
@Component
@Slf4j
public class EbayApiClient {

    private static final String BASE_URL = "https://api.ebay.com";

    private final WebClient webClient;

    public EbayApiClient(GearlineProperties properties, WebClient.Builder webClientBuilder) {
        this.webClient = webClientBuilder
            .baseUrl(BASE_URL)
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
            .build();
    }

    // ── Inventory API ──────────────────────────────────────────────────────────

    /**
     * Creates or replaces an inventory item for the given SKU.
     * Idempotent — calling this multiple times with the same SKU updates the item.
     *
     * PUT /sell/inventory/v1/inventory_item/{sku}
     * Returns 204 No Content on success.
     */
    public void createOrUpdateInventoryItem(MarketplaceAccount account, String sku, Map<String, Object> body) {
        try {
            webClient.put()
                .uri("/sell/inventory/v1/inventory_item/{sku}", sku)
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .bodyValue(body)
                .retrieve()
                .toBodilessEntity()
                .block();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to create/update inventory item for SKU '" + sku + "': "
                    + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Fetches the current inventory item for a SKU.
     *
     * GET /sell/inventory/v1/inventory_item/{sku}
     *
     * Used by syncInventory() to read the existing full body before merging the
     * new quantity and sending the full PUT back. This prevents a quantity-only
     * PUT from wiping the listing's title, description, condition, and images.
     *
     * Returns null if the item doesn't exist (404). Throws EbayApiException on
     * any other error.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> getInventoryItem(MarketplaceAccount account, String sku) {
        try {
            return webClient.get()
                .uri("/sell/inventory/v1/inventory_item/{sku}", sku)
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
        } catch (WebClientResponseException e) {
            if (e.getStatusCode().value() == 404) {
                return null; // item not yet created — caller must send a full body
            }
            throw new EbayApiException(
                "Failed to get inventory item for SKU '" + sku + "': "
                    + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Creates a new offer for the given SKU.
     *
     * POST /sell/inventory/v1/offer
     * Returns {"offerId": "..."}.
     *
     * Note: eBay requires the Content-Language header on offer create/update calls.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> createOffer(MarketplaceAccount account, Map<String, Object> body) {
        try {
            return webClient.post()
                .uri("/sell/inventory/v1/offer")
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .header("Content-Language", "en-US")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(Map.class)
                .block();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to create offer: " + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Updates an existing offer (price, policies, category).
     *
     * PUT /sell/inventory/v1/offer/{offerId}
     * Returns 204 No Content on success.
     *
     * Note: eBay requires the Content-Language header on offer create/update calls.
     */
    public void updateOffer(MarketplaceAccount account, String offerId, Map<String, Object> body) {
        try {
            webClient.put()
                .uri("/sell/inventory/v1/offer/{offerId}", offerId)
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .header("Content-Language", "en-US")
                .bodyValue(body)
                .retrieve()
                .toBodilessEntity()
                .block();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to update offer '" + offerId + "': "
                    + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Publishes an offer, making it a live listing on eBay.
     *
     * POST /sell/inventory/v1/offer/{offerId}/publish
     * Returns {"listingId": "..."}.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> publishOffer(MarketplaceAccount account, String offerId) {
        try {
            return webClient.post()
                .uri("/sell/inventory/v1/offer/{offerId}/publish", offerId)
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to publish offer '" + offerId + "': "
                    + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Withdraws (ends) an offer, removing the listing from eBay.
     *
     * POST /sell/inventory/v1/offer/{offerId}/withdraw
     * Returns 200 with a listingId in the response body.
     */
    public void withdrawOffer(MarketplaceAccount account, String offerId) {
        try {
            webClient.post()
                .uri("/sell/inventory/v1/offer/{offerId}/withdraw", offerId)
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .retrieve()
                .toBodilessEntity()
                .block();
        } catch (WebClientResponseException e) {
            if (e.getStatusCode() == HttpStatus.NOT_FOUND) {
                log.info("eBay offer {} already gone or not found — treating as withdrawn", offerId);
                return;
            }
            throw new EbayApiException(
                "Failed to withdraw offer '" + offerId + "': "
                    + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    // ── Fulfillment API ────────────────────────────────────────────────────────

    /**
     * Fetches orders created since the given ISO-8601 timestamp.
     *
     * GET /sell/fulfillment/v1/order?filter=creationdate:[{since}..],limit=50&offset={offset}
     *
     * Response shape:
     * <pre>
     * {
     *   "total": 3,
     *   "orders": [ ... ],
     *   "next": "..."   // present when more pages exist
     * }
     * </pre>
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> getOrders(MarketplaceAccount account, String since, int offset) {
        try {
            return webClient.get()
                .uri(uriBuilder -> uriBuilder
                    .path("/sell/fulfillment/v1/order")
                    .queryParam("filter", "creationdate:[" + since + "..]")
                    .queryParam("limit", 50)
                    .queryParam("offset", offset)
                    .build())
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to fetch eBay orders: " + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Fetches a single order by its eBay order ID.
     *
     * GET /sell/fulfillment/v1/order/{orderId}
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> getOrder(MarketplaceAccount account, String orderId) {
        try {
            return webClient.get()
                .uri("/sell/fulfillment/v1/order/{orderId}", orderId)
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to fetch eBay order '" + orderId + "': "
                    + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Creates a shipping fulfillment record on an eBay order (marks it as shipped).
     *
     * eBay Sell Fulfillment API:
     *   POST /sell/fulfillment/v1/order/{orderId}/shippingFulfillment
     *
     * Request body:
     * <pre>
     * {
     *   "lineItems": [{"lineItemId": "...", "quantity": 1}, ...],
     *   "shippedDate": "2024-01-10T00:00:00.000Z",
     *   "shippingCarrierCode": "USPS",
     *   "trackingNumber": "12345"
     * }
     * </pre>
     *
     * The {@code lineItems} list is built from the Order's stored line items;
     * each item's {@code externalListingId} holds the eBay lineItemId captured
     * at import time.
     *
     * @param account      the eBay marketplace account
     * @param orderId      eBay order ID (from Order.externalOrderId)
     * @param lineItems    list of {lineItemId, quantity} maps for every line in the order
     * @param trackingNumber carrier tracking number
     * @param carrier        eBay carrier code (e.g. "USPS", "UPS", "FedEx")
     * @param shippedDate    ISO-8601 timestamp of shipment
     */
    public void markOrderShipped(MarketplaceAccount account, String orderId,
                                  java.util.List<Map<String, Object>> lineItems,
                                  String trackingNumber, String carrier, String shippedDate) {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("lineItems", lineItems);
        body.put("shippedDate", shippedDate);
        body.put("shippingCarrierCode", carrier != null ? carrier : "OTHER");
        body.put("trackingNumber", trackingNumber != null ? trackingNumber : "");

        try {
            webClient.post()
                .uri("/sell/fulfillment/v1/order/{orderId}/shippingFulfillment", orderId)
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .bodyValue(body)
                .retrieve()
                .toBodilessEntity()
                .block();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to mark eBay order " + orderId + " as shipped: "
                    + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    // ── Account API — policies + location ─────────────────────────────────────

    /**
     * Lists all merchant locations registered for the seller's account.
     *
     * GET /sell/inventory/v1/location
     * Returns { "locations": [...] }
     *
     * Each location object has at minimum:
     *   { "merchantLocationKey": "MAIN", "name": "Main Warehouse",
     *     "merchantLocationStatus": "ENABLED" }
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> getMerchantLocations(MarketplaceAccount account) {
        try {
            Map<String, Object> response = webClient.get()
                .uri("/sell/inventory/v1/location")
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
            if (response == null) return List.of();
            Object locations = response.get("locations");
            return locations instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to fetch merchant locations: " + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Creates a new merchant location for the seller's account.
     *
     * POST /sell/inventory/v1/location/{merchantLocationKey}
     * eBay returns 204 No Content on success.
     *
     * The merchantLocationKey is a seller-defined identifier (max 36 chars, alphanumeric + _ + -).
     * You must send at minimum a name and a country in location.address.
     */
    public void createMerchantLocation(MarketplaceAccount account,
                                       String merchantLocationKey,
                                       String name,
                                       String addressLine1,
                                       String city,
                                       String stateOrProvince,
                                       String postalCode) {
        Map<String, Object> address = new java.util.LinkedHashMap<>();
        if (addressLine1 != null && !addressLine1.isBlank()) address.put("addressLine1", addressLine1.strip());
        if (city != null && !city.isBlank()) address.put("city", city.strip());
        if (stateOrProvince != null && !stateOrProvince.isBlank()) address.put("stateOrProvince", stateOrProvince.strip().toUpperCase());
        if (postalCode != null && !postalCode.isBlank()) address.put("postalCode", postalCode.strip());
        address.put("country", "US");

        Map<String, Object> location = Map.of("address", address);
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("location", location);
        body.put("locationTypes", List.of("WAREHOUSE"));
        body.put("name", name.strip());
        body.put("merchantLocationStatus", "ENABLED");

        try {
            webClient.post()
                .uri("/sell/inventory/v1/location/" + merchantLocationKey.strip())
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .header(HttpHeaders.CONTENT_TYPE, "application/json")
                .bodyValue(body)
                .retrieve()
                .toBodilessEntity()
                .block();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to create merchant location: " + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Lists all fulfillment (shipping) policies for the seller's account.
     *
     * GET /sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US
     * Returns { "fulfillmentPolicies": [...] }
     *
     * Each policy has: { "fulfillmentPolicyId": "uuid", "name": "Standard Shipping" }
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> getFulfillmentPolicies(MarketplaceAccount account) {
        try {
            Map<String, Object> response = webClient.get()
                .uri(uri -> uri.path("/sell/account/v1/fulfillment_policy")
                    .queryParam("marketplace_id", "EBAY_US").build())
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
            if (response == null) return List.of();
            Object policies = response.get("fulfillmentPolicies");
            return policies instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to fetch fulfillment policies: " + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Lists all return policies for the seller's account.
     *
     * GET /sell/account/v1/return_policy?marketplace_id=EBAY_US
     * Returns { "returnPolicies": [...] }
     *
     * Each policy has: { "returnPolicyId": "uuid", "name": "30-day returns" }
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> getReturnPolicies(MarketplaceAccount account) {
        try {
            Map<String, Object> response = webClient.get()
                .uri(uri -> uri.path("/sell/account/v1/return_policy")
                    .queryParam("marketplace_id", "EBAY_US").build())
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
            if (response == null) return List.of();
            Object policies = response.get("returnPolicies");
            return policies instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to fetch return policies: " + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Searches eBay's category tree for categories matching a text query.
     *
     * GET /commerce/taxonomy/v1/category_tree/0/get_category_suggestions?category_name={q}
     * (Tree ID 0 = eBay US)
     *
     * Returns { "categorySuggestions": [{ "category": { "categoryId": "33034",
     *   "categoryName": "Electric Guitars" }, "categoryTreeNodeLevel": 4 }] }
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> getCategorySuggestions(MarketplaceAccount account, String query) {
        try {
            Map<String, Object> response = webClient.get()
                .uri(uri -> uri.path("/commerce/taxonomy/v1/category_tree/0/get_category_suggestions")
                    .queryParam("category_name", query).build())
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
            if (response == null) return List.of();
            Object suggestions = response.get("categorySuggestions");
            return suggestions instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
        } catch (WebClientResponseException e) {
            throw new EbayApiException(
                "Failed to fetch category suggestions: " + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e);
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private String bearer(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        if (creds == null || !creds.containsKey("access_token")) {
            throw new EbayApiException("No access token for eBay account: " + account.getId(), null);
        }
        return "Bearer " + creds.get("access_token");
    }
}
