package com.gearline.marketplace.reverb.client;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.marketplace.reverb.dto.ReverbListingDto;
import com.gearline.marketplace.reverb.dto.ReverbOrderDto;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.util.List;
import java.util.Map;

/**
 * Low-level HTTP client for the Reverb API.
 * All methods accept a MarketplaceAccount to extract the access token.
 * Throws ReverbApiException on API errors.
 */
@Component
@Slf4j
public class ReverbApiClient {

    private static final String REVERB_API_VERSION = "3.0";
    private final WebClient webClient;

    public ReverbApiClient(GearlineProperties properties, WebClient.Builder webClientBuilder) {
        this.webClient = webClientBuilder
            .baseUrl(properties.getReverb().getApiBaseUrl())
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .defaultHeader("Accept-Version", REVERB_API_VERSION)
            .build();
    }

    /**
     * Creates a new listing on Reverb.
     */
    public ReverbListingDto createListing(MarketplaceAccount account, Map<String, Object> body) {
        try {
            return webClient.post()
                .uri("/listings")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + getAccessToken(account))
                .bodyValue(body)
                .retrieve()
                .bodyToMono(ReverbListingDto.class)
                .block();
        } catch (WebClientResponseException e) {
            throw new ReverbApiException("Failed to create listing: " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Updates an existing listing by Reverb listing ID.
     */
    public ReverbListingDto updateListing(MarketplaceAccount account, String listingId, Map<String, Object> body) {
        try {
            return webClient.put()
                .uri("/listings/{id}", listingId)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + getAccessToken(account))
                .bodyValue(body)
                .retrieve()
                .bodyToMono(ReverbListingDto.class)
                .block();
        } catch (WebClientResponseException e) {
            throw new ReverbApiException("Failed to update listing " + listingId + ": " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Ends (delists) a listing by Reverb listing ID.
     */
    public void endListing(MarketplaceAccount account, String listingId) {
        try {
            webClient.put()
                .uri("/listings/{id}/state/end", listingId)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + getAccessToken(account))
                .retrieve()
                .toBodilessEntity()
                .block();
        } catch (WebClientResponseException e) {
            if (e.getStatusCode().value() == 404) {
                // Already gone — idempotent
                log.info("Reverb listing {} already ended or not found", listingId);
                return;
            }
            throw new ReverbApiException("Failed to end listing " + listingId + ": " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Updates inventory quantity for a listing.
     */
    public void updateInventory(MarketplaceAccount account, String listingId, int quantity) {
        Map<String, Object> body = Map.of("inventory", Map.of("total", quantity));
        try {
            webClient.put()
                .uri("/listings/{id}", listingId)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + getAccessToken(account))
                .bodyValue(body)
                .retrieve()
                .toBodilessEntity()
                .block();
        } catch (WebClientResponseException e) {
            throw new ReverbApiException("Failed to update inventory for listing " + listingId, e);
        }
    }

    /**
     * Fetches orders from Reverb with optional pagination.
     */
    public List<ReverbOrderDto> getOrders(MarketplaceAccount account, String createdAfter, int page) {
        try {
            Map<String, Object> response = webClient.get()
                .uri(uriBuilder -> uriBuilder
                    .path("/my/orders/selling/all")
                    .queryParam("created_after", createdAfter)
                    .queryParam("page", page)
                    .queryParam("per_page", 50)
                    .build())
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + getAccessToken(account))
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .block();

            // Reverb returns { "orders": [...], "total": N, "current_page": N, "total_pages": N }
            @SuppressWarnings("unchecked")
            List<ReverbOrderDto> orders = (List<ReverbOrderDto>) (response != null ? response.get("orders") : List.of());
            return orders != null ? orders : List.of();
        } catch (WebClientResponseException e) {
            throw new ReverbApiException("Failed to fetch orders: " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Fetches a single order by Reverb order ID.
     */
    public ReverbOrderDto getOrder(MarketplaceAccount account, String orderId) {
        try {
            return webClient.get()
                .uri("/my/orders/selling/{id}", orderId)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + getAccessToken(account))
                .retrieve()
                .bodyToMono(ReverbOrderDto.class)
                .block();
        } catch (WebClientResponseException e) {
            throw new ReverbApiException("Failed to fetch order " + orderId + ": " + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Fetches the seller's saved shipping profiles from Reverb.
     *
     * Reverb API: GET /api/shipping_profiles
     * Returns a list of objects; each has at minimum "id" (integer) and "name" (string).
     * The profile "id" is what must be sent as "shipping_profile_id" on a listing.
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> getShippingProfiles(MarketplaceAccount account) {
        try {
            Map<String, Object> response = webClient.get()
                .uri("/shipping_profiles")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + getAccessToken(account))
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .block();
            List<Map<String, Object>> profiles =
                (List<Map<String, Object>>) (response != null ? response.get("shipping_profiles") : null);
            return profiles != null ? profiles : List.of();
        } catch (WebClientResponseException e) {
            throw new ReverbApiException(
                "Reverb API error fetching shipping profiles (HTTP " + e.getStatusCode().value() + "): "
                + e.getResponseBodyAsString(), e);
        }
    }

    /**
     * Validates that stored credentials are still working.
     */
    public boolean verifyToken(MarketplaceAccount account) {
        try {
            webClient.get()
                .uri("/my/account")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + getAccessToken(account))
                .retrieve()
                .toBodilessEntity()
                .block();
            return true;
        } catch (WebClientResponseException e) {
            return false;
        }
    }

    /**
     * Marks a Reverb order as shipped with tracking information.
     *
     * Reverb API: POST /api/v3.0/my/orders/{orderId}/ship
     * Body: {"shipment": {"tracking_number": "...", "provider": "UPS"}}
     *
     * @param account        the Reverb marketplace account
     * @param orderId        Reverb order ID (from Order.externalOrderId)
     * @param trackingNumber carrier tracking number
     * @param carrier        carrier name, e.g. "USPS", "UPS", "FedEx"
     */
    public void markOrderShipped(MarketplaceAccount account, String orderId,
                                  String trackingNumber, String carrier) {
        Map<String, Object> body = Map.of(
            "shipment", Map.of(
                "tracking_number", trackingNumber != null ? trackingNumber : "",
                "provider", carrier != null ? carrier : "Other"
            )
        );

        try {
            webClient.post()
                .uri("/my/orders/{id}/ship", orderId)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + getAccessToken(account))
                .bodyValue(body)
                .retrieve()
                .toBodilessEntity()
                .block();
        } catch (WebClientResponseException e) {
            throw new ReverbApiException(
                "Failed to mark Reverb order " + orderId + " as shipped: " + e.getResponseBodyAsString(), e);
        }
    }

    private String getAccessToken(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        if (creds == null || !creds.containsKey("access_token")) {
            throw new ReverbApiException("No access token for account: " + account.getId(), null);
        }
        return creds.get("access_token");
    }
}
