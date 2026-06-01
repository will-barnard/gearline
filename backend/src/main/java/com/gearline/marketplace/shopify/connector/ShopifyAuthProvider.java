package com.gearline.marketplace.shopify.connector;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.marketplace.common.connector.MarketplaceAuthProvider;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Auth provider for Shopify.
 *
 * Shopify uses permanent (non-expiring) access tokens obtained during OAuth.
 * There is no refresh flow — tokens are valid indefinitely unless the merchant
 * revokes the app installation from their Shopify admin.
 *
 * The full OAuth install/callback flow lives in {@link com.gearline.marketplace.shopify.oauth.ShopifyOAuthController}.
 * This provider handles only runtime credential validation.
 */
@Component
@Slf4j
public class ShopifyAuthProvider implements MarketplaceAuthProvider {

    /**
     * Not used at runtime — Shopify OAuth is handled by ShopifyOAuthController.
     */
    @Override
    public String buildAuthorizationUrl(String state, String redirectUri) {
        throw new UnsupportedOperationException(
            "Shopify authorization URL is built by ShopifyOAuthController, not this provider");
    }

    /**
     * Not used at runtime — token exchange is handled by ShopifyOAuthController.
     */
    @Override
    public Map<String, String> exchangeCodeForTokens(String code, String redirectUri) {
        throw new UnsupportedOperationException(
            "Shopify token exchange is handled by ShopifyOAuthController, not this provider");
    }

    /**
     * Shopify access tokens do not expire — there is nothing to refresh.
     * If a token has been revoked, the merchant must re-install the app.
     */
    @Override
    public void refreshAccessToken(MarketplaceAccount account) {
        log.debug("Shopify tokens do not expire — refreshAccessToken is a no-op for account {}",
            account.getId());
    }

    /**
     * A Shopify token is considered valid as long as it is present in stored credentials.
     * True revocation detection would require a live API call, which we skip here;
     * checkHealth() in ShopifyConnector performs that check on demand.
     */
    @Override
    public boolean areCredentialsValid(MarketplaceAccount account) {
        Map<String, String> creds = account.getEncryptedCredentials();
        return creds != null
            && creds.containsKey("access_token")
            && !creds.get("access_token").isBlank();
    }
}
