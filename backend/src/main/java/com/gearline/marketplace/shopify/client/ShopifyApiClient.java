package com.gearline.marketplace.shopify.client;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gearline.domain.marketplace.MarketplaceAccount;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
 *
 * ── Finding #13: thread-safe WebClient construction ──────────────────────────
 *
 * The previous implementation stored the {@link WebClient.Builder} prototype as a
 * field and called {@code webClientBuilder.baseUrl(baseUrl).build()} on every
 * request. {@code WebClient.Builder.baseUrl()} mutates the builder's state, so two
 * concurrent requests for different stores would race and potentially use the wrong
 * base URL.
 *
 * Fix: build a {@code baseClient} (no base URL) in the constructor using the
 * injected builder, then call {@code baseClient.mutate().baseUrl(baseUrl).build()}
 * in {@link #buildClient}. {@code WebClient.mutate()} always creates a fresh
 * {@link WebClient.Builder} instance inheriting all settings (codecs, defaults, etc.)
 * from the existing client, so each call produces an independent, immutable WebClient.
 */
@Component
@Slf4j
public class ShopifyApiClient {

    private static final String API_VERSION = "2024-10";

    private static final Pattern NEXT_PAGE_INFO_PATTERN =
        Pattern.compile("<[^>]*[?&]page_info=([^&>]+)[^>]*>;\\s*rel=\"next\"");

    /** Immutable base client with codec config applied — used as template for per-store clients. */
    private final WebClient baseClient;
    private final ObjectMapper objectMapper;

    public ShopifyApiClient(WebClient.Builder webClientBuilder, ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        // Build the base client with codec settings applied. We do NOT set a baseUrl here;
        // each per-store client is derived via baseClient.mutate().baseUrl(...).build().
        this.baseClient = webClientBuilder
            .codecs(c -> c.defaultCodecs().maxInMemorySize(16 * 1024 * 1024))
            .build();
    }

    /**
     * Creates an order in Shopify via the Admin API.
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
     */
    public Map<String, Object> exchangeCodeForToken(
        String shopDomain, String clientId, String clientSecret, String code
    ) {
        String baseUrl = "https://" + shopDomain.replaceAll("/$", "");
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> response = baseClient.mutate().baseUrl(baseUrl).build()
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

    /**
     * Fetches one page of products from the Shopify Admin REST API.
     *
     * Shopify uses cursor-based pagination: the first call omits {@code pageInfo};
     * subsequent calls pass the {@code nextPageInfo} value from the previous page's
     * {@link ShopifyProductsPage} response until {@code hasNextPage()} returns false.
     */
    public ShopifyProductsPage fetchProducts(MarketplaceAccount account, String pageInfo) {
        String uri = "/admin/api/" + API_VERSION + "/products.json?limit=250&status=active";
        if (pageInfo != null && !pageInfo.isBlank()) {
            uri = "/admin/api/" + API_VERSION + "/products.json?limit=250&page_info=" + pageInfo;
        }

        try {
            ResponseEntity<String> entity = buildClient(account)
                .get()
                .uri(uri)
                .header("X-Shopify-Access-Token", getAccessToken(account))
                .exchangeToMono(response -> response.toEntity(String.class))
                .block();

            if (entity == null) {
                log.warn("fetchProducts: null ResponseEntity from Shopify");
                return new ShopifyProductsPage(List.of(), null);
            }

            if (!entity.getStatusCode().is2xxSuccessful()) {
                String errBody = entity.getBody() != null ? entity.getBody() : "";
                log.warn("fetchProducts: Shopify returned HTTP {} — {}", entity.getStatusCode(), errBody);
                throw new ShopifyApiException(
                    "Failed to fetch Shopify products: HTTP " + entity.getStatusCode()
                        + " — " + errBody, null);
            }

            String body = entity.getBody();
            if (body == null || body.isBlank()) {
                log.warn("fetchProducts: Shopify returned HTTP {} with empty body", entity.getStatusCode());
                return new ShopifyProductsPage(List.of(), null);
            }

            JsonNode root = objectMapper.readTree(body);
            JsonNode productsNode = root.path("products");
            List<JsonNode> products = new ArrayList<>();
            if (productsNode.isArray()) {
                productsNode.forEach(products::add);
            }

            String nextPageInfo = null;
            String linkHeader = entity.getHeaders().getFirst(HttpHeaders.LINK);
            if (linkHeader != null) {
                Matcher m = NEXT_PAGE_INFO_PATTERN.matcher(linkHeader);
                if (m.find()) {
                    nextPageInfo = m.group(1);
                }
            }

            log.debug("Fetched {} products from Shopify (nextPageInfo={})", products.size(), nextPageInfo);
            return new ShopifyProductsPage(products, nextPageInfo);

        } catch (ShopifyApiException e) {
            throw e;
        } catch (Exception e) {
            log.error("fetchProducts: unexpected error — {}", e.getMessage(), e);
            throw new ShopifyApiException("Failed to fetch Shopify products: " + e.getMessage(), e);
        }
    }

    /**
     * Fetches a single product from the Shopify Admin REST API by its Shopify product ID.
     *
     * Finding #25 fix: switched from {@code .retrieve().bodyToMono()} to
     * {@code .exchangeToMono()} so that all HTTP status codes are handled uniformly
     * and codec/content-type mismatches don't surface as misleading errors.
     */
    public JsonNode fetchProduct(MarketplaceAccount account, String shopifyProductId) {
        String uri = "/admin/api/" + API_VERSION + "/products/" + shopifyProductId + ".json";
        try {
            ResponseEntity<String> entity = buildClient(account)
                .get()
                .uri(uri)
                .header("X-Shopify-Access-Token", getAccessToken(account))
                .exchangeToMono(response -> response.toEntity(String.class))
                .block();

            if (entity == null) {
                throw new ShopifyApiException("Null response fetching Shopify product " + shopifyProductId, null);
            }

            if (!entity.getStatusCode().is2xxSuccessful()) {
                String errBody = entity.getBody() != null ? entity.getBody() : "";
                throw new ShopifyApiException(
                    "Failed to fetch Shopify product " + shopifyProductId
                        + ": HTTP " + entity.getStatusCode() + " — " + errBody, null);
            }

            String body = entity.getBody();
            if (body == null || body.isBlank()) {
                throw new ShopifyApiException("Empty response for Shopify product " + shopifyProductId, null);
            }

            JsonNode root = objectMapper.readTree(body);
            return root.path("product");

        } catch (ShopifyApiException e) {
            throw e;
        } catch (Exception e) {
            throw new ShopifyApiException(
                "Failed to parse Shopify product " + shopifyProductId + ": " + e.getMessage(), e);
        }
    }

    /**
     * Fetches all metafields for a Shopify product.
     * Returns an empty list on any error — metafields are best-effort.
     */
    public List<JsonNode> fetchProductMetafields(MarketplaceAccount account, String shopifyProductId) {
        try {
            String uri = "/admin/api/" + API_VERSION + "/products/" + shopifyProductId + "/metafields.json";
            String body = buildClient(account)
                .get()
                .uri(uri)
                .header("X-Shopify-Access-Token", getAccessToken(account))
                .retrieve()
                .bodyToMono(String.class)
                .block();

            if (body == null) return List.of();

            JsonNode root = objectMapper.readTree(body);
            JsonNode metafields = root.path("metafields");
            if (!metafields.isArray()) return List.of();

            List<JsonNode> result = new ArrayList<>();
            metafields.forEach(result::add);
            return result;

        } catch (WebClientResponseException e) {
            log.warn("Could not fetch metafields for Shopify product {}: HTTP {}",
                shopifyProductId, e.getStatusCode());
            return List.of();
        } catch (Exception e) {
            log.warn("Error parsing metafields for Shopify product {}: {}", shopifyProductId, e.getMessage());
            return List.of();
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /**
     * Builds a per-store WebClient using {@code baseClient.mutate()}.
     *
     * Finding #13: {@code WebClient.mutate()} creates a fresh builder that inherits
     * all settings (codec limits, default headers) from {@code baseClient} and then
     * applies the store-specific base URL. Each call produces an independent, immutable
     * WebClient — no shared mutable state and no concurrency hazards.
     */
    private WebClient buildClient(MarketplaceAccount account) {
        String shopUrl = account.getExternalShopUrl();
        if (shopUrl == null || shopUrl.isBlank()) {
            throw new ShopifyApiException("No shop URL configured for account " + account.getId(), null);
        }
        String baseUrl = shopUrl.replaceAll("/$", "");
        if (!baseUrl.startsWith("http")) {
            baseUrl = "https://" + baseUrl;
        }
        return baseClient.mutate().baseUrl(baseUrl).build();
    }

    private String getAccessToken(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        if (creds == null || !creds.containsKey("access_token")) {
            throw new ShopifyApiException("No access token for Shopify account: " + account.getId(), null);
        }
        return creds.get("access_token");
    }
}
