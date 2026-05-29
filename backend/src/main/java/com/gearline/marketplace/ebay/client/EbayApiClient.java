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
     * Creates a new offer for the given SKU.
     *
     * POST /sell/inventory/v1/offer
     * Returns {"offerId": "..."}.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> createOffer(MarketplaceAccount account, Map<String, Object> body) {
        try {
            return webClient.post()
                .uri("/sell/inventory/v1/offer")
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
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
     */
    public void updateOffer(MarketplaceAccount account, String offerId, Map<String, Object> body) {
        try {
            webClient.put()
                .uri("/sell/inventory/v1/offer/{offerId}", offerId)
                .header(HttpHeaders.AUTHORIZATION, bearer(account))
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

    // ── Helpers ────────────────────────────────────────────────────────────────

    private String bearer(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        if (creds == null || !creds.containsKey("access_token")) {
            throw new EbayApiException("No access token for eBay account: " + account.getId(), null);
        }
        return "Bearer " + creds.get("access_token");
    }
}
