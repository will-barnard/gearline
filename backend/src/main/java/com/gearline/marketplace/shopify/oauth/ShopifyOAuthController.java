package com.gearline.marketplace.shopify.oauth;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.shopify.client.ShopifyApiClient;
import com.gearline.marketplace.shopify.client.ShopifyApiException;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.UriComponentsBuilder;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * Handles Shopify OAuth 2.0 install and callback flows.
 *
 * Flow:
 *   1. Merchant navigates to GET /api/v1/marketplace/shopify/oauth/install?shop={domain}
 *      → we redirect to Shopify's authorization page
 *   2. Shopify redirects back to GET /api/v1/marketplace/shopify/oauth/callback?shop=...&code=...&state=...&hmac=...
 *      → we validate HMAC + state nonce, exchange code for access token,
 *        create/update MarketplaceAccount, register webhooks, then redirect to the frontend
 *
 * Security:
 *   - HMAC-SHA256 of query params (excl. hmac) with client secret prevents forgery
 *   - Nonces are single-use and expire after 10 minutes
 *
 * These endpoints are permitted without authentication (SecurityConfig has permitAll for this path)
 * because the Shopify redirect happens in the merchant's browser outside our session.
 */
@RestController
@RequestMapping("/api/v1/marketplace/shopify/oauth")
@RequiredArgsConstructor
@Slf4j
public class ShopifyOAuthController {

    private static final String HMAC_ALGORITHM = "HmacSHA256";
    private static final long NONCE_EXPIRY_SECONDS = 600; // 10 minutes

    private final ShopifyApiClient shopifyApiClient;
    private final ShopifyWebhookRegistrationService webhookRegistrationService;
    private final MarketplaceAccountRepository accountRepository;
    private final GearlineProperties properties;

    /**
     * In-memory nonce store: nonce → expiry timestamp.
     * Good enough for single-instance deployments. For multi-instance, move to Redis
     * using the existing Spring Data Redis connection.
     */
    private final ConcurrentHashMap<String, Instant> pendingNonces = new ConcurrentHashMap<>();

    // ── Step 1: Install redirect ───────────────────────────────────────────────

    /**
     * Initiates the Shopify OAuth flow by redirecting to Shopify's authorization page.
     *
     * @param shop the merchant's Shopify domain, e.g. "mystore.myshopify.com"
     */
    @GetMapping("/install")
    public void install(
        @RequestParam String shop,
        jakarta.servlet.http.HttpServletResponse response
    ) throws Exception {
        validateShopDomain(shop);

        // Generate and store single-use nonce
        String nonce = UUID.randomUUID().toString().replace("-", "");
        pendingNonces.put(nonce, Instant.now().plusSeconds(NONCE_EXPIRY_SECONDS));
        evictExpiredNonces();

        GearlineProperties.Shopify shopifyCfg = properties.getShopify();
        String redirectUri = buildRedirectUri();

        String authorizationUrl = UriComponentsBuilder
            .fromHttpUrl("https://" + shop + "/admin/oauth/authorize")
            .queryParam("client_id", shopifyCfg.getClientId())
            .queryParam("scope", shopifyCfg.getScopes())
            .queryParam("redirect_uri", redirectUri)
            .queryParam("state", nonce)
            .toUriString();

        log.info("Initiating Shopify OAuth for shop '{}' → {}", shop, authorizationUrl);
        response.sendRedirect(authorizationUrl);
    }

    // ── Step 2: OAuth callback ─────────────────────────────────────────────────

    /**
     * Handles the Shopify OAuth callback after the merchant grants permission.
     *
     * Validates HMAC and state nonce, exchanges the code for an access token,
     * creates or updates the MarketplaceAccount, registers webhooks, then
     * redirects the browser to the frontend marketplaces page.
     */
    @GetMapping("/callback")
    public void callback(
        @RequestParam String shop,
        @RequestParam String code,
        @RequestParam String state,
        @RequestParam String hmac,
        HttpServletRequest request,
        jakarta.servlet.http.HttpServletResponse response
    ) throws Exception {
        // 1. Validate HMAC to confirm request is from Shopify
        validateHmac(request.getQueryString(), hmac);

        // 2. Validate and consume the nonce
        validateAndConsumeNonce(state);

        // 3. Validate shop domain format
        validateShopDomain(shop);

        GearlineProperties.Shopify shopifyCfg = properties.getShopify();

        // 4. Exchange the temporary code for a permanent access token
        Map<String, Object> tokenResponse;
        try {
            tokenResponse = shopifyApiClient.exchangeCodeForToken(
                shop, shopifyCfg.getClientId(), shopifyCfg.getClientSecret(), code
            );
        } catch (ShopifyApiException e) {
            log.error("Shopify token exchange failed for shop '{}': {}", shop, e.getMessage());
            redirectToFrontend(response, false, "Token exchange failed");
            return;
        }

        String accessToken = (String) tokenResponse.get("access_token");
        String scope = (String) tokenResponse.get("scope");

        if (accessToken == null || accessToken.isBlank()) {
            log.error("Shopify token exchange returned no access_token for shop '{}'", shop);
            redirectToFrontend(response, false, "No access token returned");
            return;
        }

        // 5. Create or update the MarketplaceAccount (idempotent — re-connecting the same store updates it)
        MarketplaceAccount account = accountRepository
            .findByExternalAccountId(shop)
            .orElse(MarketplaceAccount.builder()
                .marketplaceType(MarketplaceType.SHOPIFY)
                .externalAccountId(shop)
                .build());

        account.setDisplayName(shop);
        account.setExternalShopUrl(shop);
        account.setConnectionStatus(ConnectionStatus.CONNECTED);
        account.setActive(true);
        account.setLastError(null);
        account.setEncryptedCredentials(Map.of(
            "access_token", accessToken,
            "scope", scope != null ? scope : ""
        ));
        account = accountRepository.save(account);
        log.info("Shopify account saved for shop '{}' (id={})", shop, account.getId());

        // 6. Register webhook subscriptions (fire-and-forget — failures don't abort the connection)
        try {
            webhookRegistrationService.registerAll(account);
        } catch (Exception e) {
            log.error("Webhook registration failed for shop '{}': {}", shop, e.getMessage());
        }

        // 7. Redirect the merchant's browser back to the frontend
        redirectToFrontend(response, true, null);
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Validates the Shopify HMAC signature on the callback query string.
     *
     * Algorithm (per Shopify docs):
     *   1. Remove the "hmac" parameter from the query string
     *   2. Sort remaining key=value pairs alphabetically by key
     *   3. Join with "&"
     *   4. Compute HMAC-SHA256 with client secret as key
     *   5. Compare hex digest to the hmac parameter value
     */
    private void validateHmac(String rawQueryString, String receivedHmac) {
        try {
            GearlineProperties.Shopify shopifyCfg = properties.getShopify();

            // Parse query string into sorted map, excluding hmac
            TreeMap<String, String> params = new TreeMap<>();
            if (rawQueryString != null) {
                for (String pair : rawQueryString.split("&")) {
                    int idx = pair.indexOf('=');
                    if (idx > 0) {
                        String key = pair.substring(0, idx);
                        String value = pair.substring(idx + 1);
                        if (!"hmac".equals(key)) {
                            params.put(key, value);
                        }
                    }
                }
            }

            String message = params.entrySet().stream()
                .map(e -> e.getKey() + "=" + e.getValue())
                .collect(Collectors.joining("&"));

            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            mac.init(new SecretKeySpec(
                shopifyCfg.getClientSecret().getBytes(StandardCharsets.UTF_8),
                HMAC_ALGORITHM
            ));
            String computed = HexFormat.of().formatHex(
                mac.doFinal(message.getBytes(StandardCharsets.UTF_8))
            );

            if (!computed.equals(receivedHmac)) {
                log.warn("Shopify OAuth HMAC mismatch — possible request forgery");
                throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid HMAC signature");
            }
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            log.error("HMAC validation error: {}", e.getMessage());
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "HMAC validation error");
        }
    }

    private void validateAndConsumeNonce(String state) {
        Instant expiry = pendingNonces.remove(state);
        if (expiry == null || Instant.now().isAfter(expiry)) {
            log.warn("Shopify OAuth callback with invalid or expired nonce: {}", state);
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid or expired OAuth state");
        }
    }

    /**
     * Validates that the shop domain looks like a legitimate myshopify.com domain.
     * Prevents open redirect attacks where an attacker supplies a crafted shop URL.
     */
    private void validateShopDomain(String shop) {
        if (shop == null || !shop.matches("^[a-zA-Z0-9][a-zA-Z0-9\\-]*\\.myshopify\\.com$")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                "Invalid shop domain. Must be a valid .myshopify.com domain (e.g. mystore.myshopify.com)");
        }
    }

    private String buildRedirectUri() {
        String base = properties.getApp().getBaseUrl();
        if (base == null || base.isBlank()) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                "APP_BASE_URL is not configured — cannot build Shopify OAuth redirect URI");
        }
        return base.replaceAll("/$", "") + "/api/v1/marketplace/shopify/oauth/callback";
    }

    private void redirectToFrontend(
        jakarta.servlet.http.HttpServletResponse response,
        boolean success,
        String errorMessage
    ) throws Exception {
        String frontendBase = properties.getApp().getBaseUrl();
        if (frontendBase == null || frontendBase.isBlank()) {
            frontendBase = "http://localhost:5173";
        }

        URI target = UriComponentsBuilder
            .fromHttpUrl(frontendBase.replaceAll("/$", "") + "/marketplaces")
            .queryParam("shopify_connected", success ? "true" : "false")
            .queryParamIfPresent("error", java.util.Optional.ofNullable(errorMessage))
            .build()
            .toUri();

        response.sendRedirect(target.toString());
    }

    /** Removes expired nonces to prevent unbounded memory growth. */
    private void evictExpiredNonces() {
        Instant now = Instant.now();
        pendingNonces.entrySet().removeIf(e -> now.isAfter(e.getValue()));
    }
}
