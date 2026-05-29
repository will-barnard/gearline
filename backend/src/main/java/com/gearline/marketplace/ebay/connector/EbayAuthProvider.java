package com.gearline.marketplace.ebay.connector;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.marketplace.common.connector.MarketplaceAuthProvider;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Base64;
import java.util.Map;

/**
 * eBay OAuth 2.0 provider.
 * Uses eBay's Authorization Code grant for user-scoped access.
 * https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant.html
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class EbayAuthProvider implements MarketplaceAuthProvider {

    private static final String EBAY_SCOPES =
        "https://api.ebay.com/oauth/api_scope " +
        "https://api.ebay.com/oauth/api_scope/sell.inventory " +
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment";

    private final GearlineProperties properties;
    private final MarketplaceAccountRepository accountRepository;

    @Override
    public String buildAuthorizationUrl(String state, String redirectUri) {
        return properties.getEbay().getAuthUrl() + "/authorize"
            + "?client_id=" + properties.getEbay().getClientId()
            + "&redirect_uri=" + redirectUri
            + "&response_type=code"
            + "&scope=" + EBAY_SCOPES.replace(" ", "%20")
            + "&state=" + state;
    }

    @Override
    public Map<String, String> exchangeCodeForTokens(String code, String redirectUri) {
        // TODO: POST to https://api.ebay.com/identity/v1/oauth2/token
        // with Basic auth (Base64 clientId:clientSecret) and form body:
        //   grant_type=authorization_code, code=..., redirect_uri=...
        throw new UnsupportedOperationException("eBay OAuth exchange not yet implemented");
    }

    @Override
    public void refreshAccessToken(MarketplaceAccount account) {
        // TODO: POST to https://api.ebay.com/identity/v1/oauth2/token
        // with grant_type=refresh_token and refresh_token=...
        log.warn("eBay token refresh not yet implemented for account {}", account.getId());
        account.setConnectionStatus(ConnectionStatus.TOKEN_EXPIRED);
        accountRepository.save(account);
    }

    @Override
    public boolean areCredentialsValid(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        if (creds == null || !creds.containsKey("access_token")) return false;

        String expiresAt = creds.get("expires_at");
        if (expiresAt != null) {
            return Instant.now().toEpochMilli() < (Long.parseLong(expiresAt) - 300_000);
        }
        return false;
    }

    private String basicAuthHeader() {
        String credentials = properties.getEbay().getClientId() + ":" + properties.getEbay().getClientSecret();
        return "Basic " + Base64.getEncoder().encodeToString(credentials.getBytes());
    }
}
