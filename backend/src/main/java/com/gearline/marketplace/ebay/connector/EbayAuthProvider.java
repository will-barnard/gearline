package com.gearline.marketplace.ebay.connector;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.marketplace.common.connector.MarketplaceAuthProvider;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
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
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

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

    /**
     * Scopes required for inventory management, order fulfilment, and account config
     * (fulfillment/return policies via the Account API).
     *
     * sell.account.readonly — required for GET /sell/account/v1/fulfillment_policy
     *                          and GET /sell/account/v1/return_policy
     */
    static final String EBAY_SCOPES =
        "https://api.ebay.com/oauth/api_scope " +
        "https://api.ebay.com/oauth/api_scope/sell.inventory " +
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment " +
        "https://api.ebay.com/oauth/api_scope/sell.account.readonly";

    /** Token endpoint — separate from the auth URL. */
    private static final String TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";

    private final GearlineProperties properties;
    private final MarketplaceAccountRepository accountRepository;
    private final WebClient.Builder webClientBuilder;

    /** Per-account lock to prevent concurrent token refresh races (finding #24). */
    private final ConcurrentHashMap<UUID, Object> refreshLocks = new ConcurrentHashMap<>();

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
    /**
     * Refreshes an expired access token using the stored refresh token.
     *
     * Finding #24 fix: synchronized on a per-account lock so that concurrent requests
     * for the same account don't race to refresh — only one refresh runs at a time,
     * and the second thread re-checks validity after acquiring the lock.
     */
    @Override
    public void refreshAccessToken(MarketplaceAccount account) {
        Object lock = refreshLocks.computeIfAbsent(account.getId(), id -> new Object());
        synchronized (lock) {
            try {
                // Re-check: another thread may have just refreshed this token
                if (areCredentialsValid(account)) {
                    log.debug("eBay token for account {} already valid (refreshed by another thread)",
                        account.getId());
                    return;
                }

                Map<String, String> creds = account.getEncryptedCredentials();
                if (creds == null || !creds.containsKey("refresh_token")) {
                    log.warn("No refresh token for eBay account {} — marking TOKEN_EXPIRED", account.getId());
                    account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
                    saveAccount(account);
                    return;
                }

                MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
                form.add("grant_type",    "refresh_token");
                form.add("refresh_token", creds.get("refresh_token"));
                form.add("scope",         EBAY_SCOPES);

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
                    saveAccount(account);
                    log.info("Refreshed eBay access token for account {}", account.getId());
                } else {
                    throw new RuntimeException("Empty or missing access_token in refresh response: " + response);
                }

            } catch (WebClientResponseException e) {
                log.error("eBay token refresh HTTP error for account {}: {} — {}",
                    account.getId(), e.getStatusCode(), e.getResponseBodyAsString());
                account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
                saveAccount(account);
            } catch (Exception e) {
                log.error("eBay token refresh failed for account {}: {}", account.getId(), e.getMessage());
                account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
                saveAccount(account);
            } finally {
                refreshLocks.remove(account.getId());
            }
        }
    }

    /**
     * Finding #26: save the account entity, retrying once on optimistic lock failure.
     *
     * Per-account {@link #refreshLocks} prevents concurrent refresh within a single JVM,
     * but in multi-node deployments two nodes may race. On
     * {@link ObjectOptimisticLockingFailureException}, reload the fresh entity, re-apply
     * the pending credential/status changes, and retry the save once.
     */
    private void saveAccount(MarketplaceAccount account) {
        try {
            accountRepository.save(account);
        } catch (ObjectOptimisticLockingFailureException e) {
            log.warn("Optimistic lock conflict saving eBay account {} — reloading and retrying",
                account.getId());
            accountRepository.findById(account.getId()).ifPresentOrElse(fresh -> {
                fresh.setEncryptedCredentials(account.getEncryptedCredentials());
                fresh.setConnectionStatus(account.getConnectionStatus());
                try {
                    accountRepository.save(fresh);
                    log.info("eBay account {} saved successfully on retry", account.getId());
                } catch (Exception retryEx) {
                    log.error("Retry save for eBay account {} also failed: {}",
                        account.getId(), retryEx.getMessage());
                }
            }, () -> log.error("eBay account {} not found during optimistic-lock retry", account.getId()));
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
