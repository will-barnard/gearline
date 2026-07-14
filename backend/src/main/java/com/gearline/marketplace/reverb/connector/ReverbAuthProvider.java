package com.gearline.marketplace.reverb.connector;

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

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages Reverb OAuth 2.0 token lifecycle.
 * Reverb uses standard OAuth2 authorization code flow.
 * https://reverb.com/page/api#authentication
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ReverbAuthProvider implements MarketplaceAuthProvider {

    private final GearlineProperties properties;
    private final MarketplaceAccountRepository accountRepository;
    private final WebClient.Builder webClientBuilder;

    /**
     * Per-account mutex map to prevent concurrent token refresh races (finding #24).
     * Two simultaneous requests for the same account would both detect an expired token
     * and both call the Reverb token endpoint, causing the first refresh to be
     * invalidated by the second. Synchronizing on a per-account lock ensures only one
     * refresh runs at a time; the second thread re-checks validity after acquiring the
     * lock and short-circuits if the first thread already refreshed successfully.
     */
    private final ConcurrentHashMap<UUID, Object> refreshLocks = new ConcurrentHashMap<>();

    @Override
    public String buildAuthorizationUrl(String state, String redirectUri) {
        return properties.getReverb().getAuthUrl() + "/authorize"
            + "?client_id=" + properties.getReverb().getClientId()
            + "&redirect_uri=" + redirectUri
            + "&response_type=code"
            + "&scope=read_listings+write_listings+read_orders"
            + "&state=" + state;
    }

    @Override
    public Map<String, String> exchangeCodeForTokens(String code, String redirectUri) {
        WebClient client = webClientBuilder.baseUrl(properties.getReverb().getAuthUrl()).build();

        MultiValueMap<String, String> formData = new LinkedMultiValueMap<>();
        formData.add("client_id", properties.getReverb().getClientId());
        formData.add("client_secret", properties.getReverb().getClientSecret());
        formData.add("code", code);
        formData.add("redirect_uri", redirectUri);
        formData.add("grant_type", "authorization_code");

        @SuppressWarnings("unchecked")
        Map<String, Object> response = client.post()
            .uri("/token")
            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
            .body(BodyInserters.fromFormData(formData))
            .retrieve()
            .bodyToMono(Map.class)
            .block();

        if (response == null) {
            throw new RuntimeException("Empty token response from Reverb");
        }

        Map<String, String> credentials = new HashMap<>();
        credentials.put("access_token", (String) response.get("access_token"));
        credentials.put("refresh_token", (String) response.get("refresh_token"));
        credentials.put("token_type", (String) response.getOrDefault("token_type", "Bearer"));

        // Calculate expiry timestamp
        Object expiresIn = response.get("expires_in");
        if (expiresIn != null) {
            long expiry = Instant.now().plusSeconds(Long.parseLong(expiresIn.toString())).toEpochMilli();
            credentials.put("expires_at", String.valueOf(expiry));
        }

        return credentials;
    }

    @Override
    public void refreshAccessToken(MarketplaceAccount account) {
        // Finding #24: per-account lock prevents concurrent refresh races.
        // The second thread to acquire the lock re-checks validity and exits early
        // if the first thread already refreshed the token.
        Object lock = refreshLocks.computeIfAbsent(account.getId(), id -> new Object());
        synchronized (lock) {
            try {
                // Re-check: another thread may have just refreshed this token
                if (areCredentialsValid(account)) {
                    log.debug("Reverb token for account {} already valid (refreshed by another thread)",
                        account.getId());
                    return;
                }

                Map<String, String> creds = account.getEncryptedCredentials();
                if (creds == null || !creds.containsKey("refresh_token")) {
                    log.warn("No refresh token available for Reverb account {}", account.getId());
                    account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
                    saveAccount(account);
                    return;
                }

                WebClient client = webClientBuilder.baseUrl(properties.getReverb().getAuthUrl()).build();

                MultiValueMap<String, String> formData = new LinkedMultiValueMap<>();
                formData.add("client_id", properties.getReverb().getClientId());
                formData.add("client_secret", properties.getReverb().getClientSecret());
                formData.add("refresh_token", creds.get("refresh_token"));
                formData.add("grant_type", "refresh_token");

                @SuppressWarnings("unchecked")
                Map<String, Object> response = client.post()
                    .uri("/token")
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(BodyInserters.fromFormData(formData))
                    .retrieve()
                    .bodyToMono(Map.class)
                    .block();

                if (response != null && response.containsKey("access_token")) {
                    Map<String, String> updatedCreds = new HashMap<>(creds);
                    updatedCreds.put("access_token", (String) response.get("access_token"));
                    if (response.containsKey("refresh_token")) {
                        updatedCreds.put("refresh_token", (String) response.get("refresh_token"));
                    }
                    if (response.containsKey("expires_in")) {
                        long expiry = Instant.now()
                            .plusSeconds(Long.parseLong(response.get("expires_in").toString()))
                            .toEpochMilli();
                        updatedCreds.put("expires_at", String.valueOf(expiry));
                    }

                    account.setEncryptedCredentials(updatedCreds);
                    account.setConnectionStatus(ConnectionStatus.CONNECTED);
                    saveAccount(account);
                    log.info("Successfully refreshed Reverb token for account {}", account.getId());
                } else {
                    // Finding #11: previous code silently did nothing when the refresh
                    // response was non-null but contained no access_token (e.g. an error body).
                    // Now we log the response and mark the account TOKEN_EXPIRED.
                    log.error("Reverb token refresh for account {} returned a response with no access_token: {}",
                        account.getId(), response);
                    account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
                    saveAccount(account);
                }
            } catch (Exception e) {
                log.error("Failed to refresh Reverb token for account {}: {}", account.getId(), e.getMessage());
                account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
                accountRepository.save(account);
            } finally {
                refreshLocks.remove(account.getId());
            }
        }
    }

    /**
     * Finding #26: save the account entity, retrying once on optimistic lock failure.
     *
     * An {@link ObjectOptimisticLockingFailureException} can occur in multi-node
     * deployments where a second node refreshes the same token concurrently. The
     * per-account {@link #refreshLocks} map prevents this within a single JVM, but
     * cannot help across nodes. On conflict, we reload the fresh entity, re-apply
     * the same credential/status changes, and retry the save once.
     */
    private void saveAccount(MarketplaceAccount account) {
        try {
            accountRepository.save(account);
        } catch (ObjectOptimisticLockingFailureException e) {
            log.warn("Optimistic lock conflict saving Reverb account {} — reloading and retrying",
                account.getId());
            accountRepository.findById(account.getId()).ifPresentOrElse(fresh -> {
                fresh.setEncryptedCredentials(account.getEncryptedCredentials());
                fresh.setConnectionStatus(account.getConnectionStatus());
                try {
                    accountRepository.save(fresh);
                    log.info("Reverb account {} saved successfully on retry", account.getId());
                } catch (Exception retryEx) {
                    log.error("Retry save for Reverb account {} also failed: {}",
                        account.getId(), retryEx.getMessage());
                }
            }, () -> log.error("Reverb account {} not found during optimistic-lock retry", account.getId()));
        }
    }

    @Override
    public boolean areCredentialsValid(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        if (creds == null || !creds.containsKey("access_token")) return false;

        String expiresAt = creds.get("expires_at");
        if (expiresAt != null) {
            long expiry = Long.parseLong(expiresAt);
            // Consider token expired 5 minutes before actual expiry
            return Instant.now().toEpochMilli() < (expiry - 300_000);
        }

        return true; // No expiry info — assume valid
    }
}
