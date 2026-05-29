package com.gearline.marketplace.common.connector;

import com.gearline.domain.marketplace.MarketplaceAccount;

import java.util.Map;

/**
 * Handles OAuth and credential management for a marketplace.
 */
public interface MarketplaceAuthProvider {

    /**
     * Generates the OAuth authorization URL to redirect the user to.
     */
    String buildAuthorizationUrl(String state, String redirectUri);

    /**
     * Exchanges an authorization code for OAuth tokens.
     * Returns a map of credential keys to encrypted values.
     */
    Map<String, String> exchangeCodeForTokens(String code, String redirectUri);

    /**
     * Refreshes the access token using the stored refresh token.
     * Updates the account credentials in-place.
     */
    void refreshAccessToken(MarketplaceAccount account);

    /**
     * Validates that stored credentials are still valid.
     */
    boolean areCredentialsValid(MarketplaceAccount account);
}
