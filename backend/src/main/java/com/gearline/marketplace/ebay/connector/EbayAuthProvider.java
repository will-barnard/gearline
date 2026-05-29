package com.gearline.marketplace.ebay.connector;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.marketplace.common.connector.MarketplaceAuthProvider;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * eBay OAuth 2.0 provider.
 *
 * eBay uses the standard Authorization Code grant with one key difference:
 * the {@code redirect_uri} parameter everywhere is the <em>RuName</em>
 * (a short registered name like "YourApp-YourApp-12345-abcde"), not the
 * actual callback URL. The actual URL is registered once in the Developer Portal.
 *
 * Docs: https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant.html
 *
 * Token endpoint: POST https://api.ebay.com/identity/v1/oauth2/token
 * Auth:           Basic base64(clientId:clientSecret)
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class EbayAuthProvider implements MarketplaceAuthProvider {

    /** Scopes required for inventory management and order fulfilment. */
    static final String EBAY_SCOPES =
        "https://api.ebay.com/oauth/api_scope " +
        "https://api.ebay.com/oauth/api_scope/sell.inventory " +
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment";

    /** Token endpoint — separate from the auth URL. */
    private static final String TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";

    private final GearlineProperties properties;
    private final MarketplaceAccountRepository accountRepository;
    private final WebClient.Builder webClientBuilder;

    // ── MarketplaceAuthProvider ────────────────────────────────────────────────

    /**
     * Builds the eBay authorization URL.
     *
     * Note: {@code redirectUri} here is the RuName, not an actual URL.
     * It is populated from {@code GearlineProperties.Ebay.ruName} by the
     * calling controller.
     */
    @Override
    public String buildAuthorizationUrl(String state, String redirectUri) {
        return properties.getEbay().getAuthUrl() + "/authorize"
            + "?client_id=" + properties.getEbay().getClientId()
            + "&redirect_uri=" + redirectUri
            + "&response_type=code"
            + "&scope=" + EBAY_SCOPES.replace(" ", "%20")
            + "&state=" + state;
    }

    /**
     * Exchanges an authorization code for an access + refresh token pair.
     *
     * POST https://api.ebay.com/identity/v1/oauth2/token
     * Auth:  Basic base64(clientId:clientSecret)
     * Body:  grant_type=authorization_code&code={code}&redirect_uri={ruName}
     *
     * @param code        temporary code from the eBay callback
     * @param redirectUri the RuName (not a URL) registered in the Developer Portal
     */
    @Override
    public Map<String, String> exchangeCodeForTokens(String code, String redirectUri) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "authorization_code");
        form.add("code", code);
        form.add("redirect_uri", redirectUri);

        @SuppressWarnings("unchecked")
        Map<String, Object> response = webClientBuilder.baseUrl(TOKEN_URL).build()
            .post()
            .uri("")
            .header("Authorization", basicAuthHeader())
            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
            .body(BodyInserters.fromFormData(form))
            .retrieve()
            .bodyToMono(Map.class)
            .block();

        if (response == null) {
            throw new RuntimeException("Empty token response from eBay");
        }

        Map<String, String> credentials = new HashMap<>();
        credentials.put("access_token",  (String) response.get("access_token"));
        credentials.put("refresh_token", (String) response.get("refresh_token"));
        credentials.put("token_type",    (String) response.getOrDefault("token_type", "Bearer"));

        // Persist absolute expiry so we can detect staleness without a round-trip
        Object expiresIn = response.get("expires_in");
        if (expiresIn != null) {
            long expiry = Instant.now().plusSeconds(Long.parseLong(expiresIn.toString())).toEpochMilli();
            credentials.put("expires_at", String.valueOf(expiry));
        }

        return credentials;
    }

    /**
     * Refreshes an expired access token using the stored refresh token.
     *
     * POST https://api.ebay.com/identity/v1/oauth2/token
     * Auth:  Basic base64(clientId:clientSecret)
     * Body:  grant_type=refresh_token&refresh_token={token}&scope={scopes}
     */
    @Override
    public void refreshAccessToken(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        if (creds == null || !creds.containsKey("refresh_token")) {
            log.warn("No refresh token for eBay account {} — marking TOKEN_EXPIRED", account.getId());
            account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
            accountRepository.save(account);
            return;
        }

        try {
            MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
            form.add("grant_type",     "refresh_token");
            form.add("refresh_token",  creds.get("refresh_token"));
            form.add("scope",          EBAY_SCOPES);

            @SuppressWarnings("unchecked")
            Map<String, Object> response = webClientBuilder.baseUrl(TOKEN_URL).build()
                .post()
                .uri("")
                .header("Authorization", basicAuthHeader())
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .body(BodyInserters.fromFormData(form))
                .retrieve()
                .bodyToMono(Map.class)
                .block();

            if (response != null && response.containsKey("access_token")) {
                Map<String, String> updated = new HashMap<>(creds);
                updated.put("access_token", (String) response.get("access_token"));

                // Refresh response may also contain a new refresh token
                if (response.containsKey("refresh_token")) {
                    updated.put("refresh_token", (String) response.get("refresh_token"));
                }
                if (response.containsKey("expires_in")) {
                    long expiry = Instant.now()
                        .plusSeconds(Long.parseLong(response.get("expires_in").toString()))
                        .toEpochMilli();
                    updated.put("expires_at", String.valueOf(expiry));
                }

                account.setEncryptedCredentials(updated);
                account.setConnectionStatus(ConnectionStatus.CONNECTED);
                accountRepository.save(account);
                log.info("Refreshed eBay access token for account {}", account.getId());
            } else {
                throw new RuntimeException("Empty or missing access_token in refresh response");
            }

        } catch (WebClientResponseException e) {
            log.error("eBay token refresh HTTP error for account {}: {} — {}",
                account.getId(), e.getStatusCode(), e.getResponseBodyAsString());
            account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
            accountRepository.save(account);
        } catch (Exception e) {
            log.error("eBay token refresh failed for account {}: {}", account.getId(), e.getMessage());
            account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
            accountRepository.save(account);
        }
    }

    @Override
    public boolean areCredentialsValid(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        if (creds == null || !creds.containsKey("access_token")) return false;

        String expiresAt = creds.get("expires_at");
        if (expiresAt != null) {
            // Treat as expired 5 minutes early to avoid races
            return Instant.now().toEpochMilli() < (Long.parseLong(expiresAt) - 300_000L);
        }
        // No expiry recorded — assume valid (token was just issued)
        return true;
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private String basicAuthHeader() {
        String raw = properties.getEbay().getClientId() + ":" + properties.getEbay().getClientSecret();
        return "Basic " + Base64.getEncoder().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }
}
