package com.gearline.marketplace.shopify.client;

import com.gearline.domain.marketplace.MarketplaceAccount;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.util.Map;

/**
 * Low-level HTTP client for the Shopify Admin REST API.
 *
 * Unlike the Reverb client (single base URL), each Shopify store has its own
 * subdomain, so we build a per-account WebClient using the shop URL stored in
 * {@code MarketplaceAccount.externalShopUrl} (e.g. "mystore.myshopify.com").
 *
 * Authentication: Shopify uses a static access token obtained during OAuth,
 * sent as the {@code X-Shopify-Access-Token} header on every request.
 * The token is stored in {@code MarketplaceAccount.encryptedCredentials["access_token"]}.
 *
 * API version: 2024-10 (Shopify's quarterly versioning; update as needed).
 */
@Component
@Slf4j
public class ShopifyApiClient {

    private static final String API_VERSION = "2024-10";

    private final WebClient.Builder webClientBuilder;

    public ShopifyApiClient(WebClient.Builder webClientBuilder) {
        this.webClientBuilder = webClientBuilder;
    }

    /**
     * Creates an order in Shopify via the Admin API.
     *
     * Endpoint: POST /admin/api/{version}/orders.json
     * Docs: https://shopify.dev/docs/api/admin-rest/2024-10/resources/order#post-orders
     *
     * @param account   the connected Shopify marketplace account
     * @param orderBody the request body — use {@link ShopifyOrderMapper} to build it
     * @return the created Shopify order response, keyed under "order"
     * @throws ShopifyApiException on any 4xx/5xx from Shopify
     */
    public Map<String, Object> createOrder(MarketplaceAccount account, Map<String, Object> orderBody) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> response = buildClient(account)
                .post()
                .uri("/admin/api/" + API_VERSION + "/orders.json")
                .header("X-Shopify-Access-Token", getAccessToken(account))
                .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .bodyValue(orderBody)
                .retrieve()
                .bodyToMono(Map.class)
                .block();
            return response;
        } catch (WebClientResponseException e) {
            throw new ShopifyApiException(
                "Failed to create Shopify order: HTTP " + e.getStatusCode() + " — " + e.getResponseBodyAsString(), e
            );
        }
    }

    /**
     * Registers a webhook subscription on the connected Shopify store.
     *
     * Endpoint: POST /admin/api/{version}/webhooks.json
     * Docs: https://shopify.dev/docs/api/admin-rest/2024-10/resources/webhook#post-webhooks
     *
     * @param account  the connected Shopify account
     * @param topic    Shopify webhook topic (e.g. "products/create")
     * @param endpoint the full HTTPS URL Shopify should call (e.g. https://myapp.com/webhooks/shopify/products/create)
     * @return the created webhook response map
     */
    public Map<String, Object> registerWebhook(MarketplaceAccount account, String topic, String endpoint) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> response = buildClient(account)
                .post()
                .uri("/admin/api/" + API_VERSION + "/webhooks.json")
                .header("X-Shopify-Access-Token", getAccessToken(account))
                .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .bodyValue(Map.of("webhook", Map.of(
                    "topic",   topic,
                    "address", endpoint,
                    "format",  "json"
                )))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
            return response;
        } catch (WebClientResponseException e) {
            throw new ShopifyApiException(
                "Failed to register webhook '" + topic + "': HTTP " + e.getStatusCode()
                    + " — " + e.getResponseBodyAsString(), e
            );
        }
    }

    /**
     * Exchanges an OAuth authorisation code for a permanent access token.
     * Called from the OAuth callback handler.
     *
     * Endpoint: POST https://{shop}/admin/oauth/access_token
     *
     * @param shopDomain the Shopify store domain (e.g. "mystore.myshopify.com")
     * @param clientId   app client ID
     * @param clientSecret app client secret
     * @param code       the temporary authorisation code from the OAuth redirect
     * @return the response map containing "access_token" and "scope"
     */
    public Map<String, Object> exchangeCodeForToken(
        String shopDomain, String clientId, String clientSecret, String code
    ) {
        String baseUrl = "https://" + shopDomain.replaceAll("/$", "");
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> response = webClientBuilder.baseUrl(baseUrl).build()
                .post()
                .uri("/admin/oauth/access_token")
                .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .bodyValue(Map.of(
                    "client_id",     clientId,
                    "client_secret", clientSecret,
                    "code",          code
                ))
                .retrieve()
                .bodyToMono(Map.class)
                .block();
            return response;
        } catch (WebClientResponseException e) {
            throw new ShopifyApiException(
                "Token exchange failed for shop " + shopDomain + ": HTTP " + e.getStatusCode()
                    + " — " + e.getResponseBodyAsString(), e
            );
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private WebClient buildClient(MarketplaceAccount account) {
        String shopUrl = account.getExternalShopUrl();
        if (shopUrl == null || shopUrl.isBlank()) {
            throw new ShopifyApiException("No shop URL configured for account " + account.getId(), null);
        }
        // Normalise: strip trailing slash and scheme if provided; add https://
        String baseUrl = shopUrl.replaceAll("/$", "");
        if (!baseUrl.startsWith("http")) {
            baseUrl = "https://" + baseUrl;
        }
        return webClientBuilder.baseUrl(baseUrl).build();
    }

    private String getAccessToken(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        if (creds == null || !creds.containsKey("access_token")) {
            throw new ShopifyApiException("No access token for Shopify account: " + account.getId(), null);
        }
        return creds.get("access_token");
    }
}
