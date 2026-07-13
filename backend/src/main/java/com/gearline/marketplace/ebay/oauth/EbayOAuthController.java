package com.gearline.marketplace.ebay.oauth;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.ebay.connector.EbayAuthProvider;
import com.gearline.service.ListingBackfillService;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Handles the eBay OAuth 2.0 Authorization Code flow.
 *
 * Flow:
 *   1. GET /api/v1/marketplace/ebay/oauth/install
 *      → Redirects the seller's browser to eBay's authorization page.
 *
 *   2. eBay redirects to GET /api/v1/marketplace/ebay/oauth/callback?code=...&state=...
 *      → Validates state nonce, exchanges code for access + refresh tokens,
 *        creates/updates the MarketplaceAccount, then redirects to the frontend.
 *
 * Key eBay quirk:
 *   The {@code redirect_uri} parameter used in both the authorization URL and the
 *   token exchange is the <em>RuName</em> (e.g. "YourApp-YourApp-12345-abcde"),
 *   not the actual callback URL. The real callback URL is registered once in the
 *   eBay Developer Portal and linked to the RuName there.
 *
 * These endpoints are permitted without authentication (SecurityConfig has
 * permitAll for this path) because the eBay redirect happens in the seller's
 * browser outside the Gearline session.
 */
@RestController
@RequestMapping("/api/v1/marketplace/ebay/oauth")
@RequiredArgsConstructor
@Slf4j
public class EbayOAuthController {

    private static final long NONCE_EXPIRY_SECONDS = 600; // 10 minutes

    private final EbayAuthProvider ebayAuthProvider;
    private final MarketplaceAccountRepository accountRepository;
    private final GearlineProperties properties;
    private final ListingBackfillService listingBackfillService;

    /** Single-use nonce store: nonce → expiry. For multi-instance, move to Redis. */
    private final ConcurrentHashMap<String, Instant> pendingNonces = new ConcurrentHashMap<>();

    // ── Step 1: Install redirect ───────────────────────────────────────────────

    /**
     * Initiates the eBay OAuth flow by redirecting the seller to eBay's
     * authorization page.
     */
    @GetMapping("/install")
    public void install(HttpServletResponse response) throws Exception {
        validateConfig();

        String nonce = UUID.randomUUID().toString().replace("-", "");
        pendingNonces.put(nonce, Instant.now().plusSeconds(NONCE_EXPIRY_SECONDS));
        evictExpiredNonces();

        // redirect_uri in the authorization URL is the RuName
        String authUrl = ebayAuthProvider.buildAuthorizationUrl(
            nonce,
            properties.getEbay().getRuName()
        );

        log.info("Initiating eBay OAuth → {}", authUrl);
        response.sendRedirect(authUrl);
    }

    // ── Step 2: OAuth callback ─────────────────────────────────────────────────

    /**
     * Handles the callback from eBay after the seller grants permission.
     *
     * eBay may also call this endpoint with {@code error} and
     * {@code error_description} parameters if the seller declined.
     */
    @GetMapping("/callback")
    public void callback(
        @RequestParam(required = false) String code,
        @RequestParam(required = false) String state,
        @RequestParam(required = false) String error,
        @RequestParam(value = "error_description", required = false) String errorDescription,
        HttpServletResponse response
    ) throws Exception {
        // eBay sends error=access_denied when the seller declines
        if (error != null) {
            log.warn("eBay OAuth declined by seller: {} — {}", error, errorDescription);
            redirectToFrontend(response, false, error);
            return;
        }

        if (code == null || state == null) {
            log.warn("eBay OAuth callback missing code or state parameters");
            redirectToFrontend(response, false, "missing_parameters");
            return;
        }

        // 1. Validate and consume the nonce
        validateAndConsumeNonce(state);

        // 2. Exchange the code for tokens
        // redirect_uri in the token exchange is also the RuName
        Map<String, String> credentials;
        try {
            credentials = ebayAuthProvider.exchangeCodeForTokens(
                code,
                properties.getEbay().getRuName()
            );
        } catch (Exception e) {
            log.error("eBay token exchange failed: {}", e.getMessage());
            redirectToFrontend(response, false, "token_exchange_failed");
            return;
        }

        if (credentials.get("access_token") == null) {
            log.error("eBay token exchange returned no access_token");
            redirectToFrontend(response, false, "no_access_token");
            return;
        }

        // 3. Create or update the MarketplaceAccount
        //    We use the access_token itself to derive a stable identifier until we
        //    have a /sell/account/v1/user call to fetch the eBay username.
        //    The account can be updated later once the user profile API is wired in.
        MarketplaceAccount account = accountRepository
            .findByMarketplaceType(MarketplaceType.EBAY)
            .stream()
            .findFirst()
            .orElse(MarketplaceAccount.builder()
                .marketplaceType(MarketplaceType.EBAY)
                .externalAccountId("ebay-" + UUID.randomUUID().toString().substring(0, 8))
                .build());

        account.setDisplayName("eBay");
        account.setConnectionStatus(ConnectionStatus.CONNECTED);
        account.setActive(true);
        account.setLastError(null);
        account.setEncryptedCredentials(Map.copyOf(credentials));
        account = accountRepository.save(account);

        log.info("eBay account connected (id={})", account.getId());

        // 4. Backfill NEEDS_REVIEW listing stubs for products that existed before eBay was connected
        listingBackfillService.backfillListingsForNewAccount(account);

        // 5. Redirect the seller back to the frontend
        redirectToFrontend(response, true, null);
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private void validateConfig() {
        GearlineProperties.Ebay cfg = properties.getEbay();
        if (isBlank(cfg.getClientId())) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                "EBAY_CLIENT_ID is not configured");
        }
        if (isBlank(cfg.getRuName())) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                "EBAY_RU_NAME is not configured — register a redirect URL in the eBay Developer Portal and set the RuName here");
        }
    }

    private void validateAndConsumeNonce(String state) {
        Instant expiry = pendingNonces.remove(state);
        if (expiry == null || Instant.now().isAfter(expiry)) {
            log.warn("eBay OAuth callback with invalid or expired state nonce: {}", state);
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                "Invalid or expired OAuth state — please try connecting again");
        }
    }

    private void redirectToFrontend(
        HttpServletResponse response,
        boolean success,
        String errorCode
    ) throws Exception {
        String base = properties.getApp().getBaseUrl();
        if (isBlank(base)) base = "http://localhost:5173";

        URI target = UriComponentsBuilder
            .fromHttpUrl(base.replaceAll("/$", "") + "/marketplaces")
            .queryParam("ebay_connected", success ? "true" : "false")
            .queryParamIfPresent("error", java.util.Optional.ofNullable(errorCode))
            .build()
            .toUri();

        response.sendRedirect(target.toString());
    }

    private void evictExpiredNonces() {
        Instant now = Instant.now();
        pendingNonces.entrySet().removeIf(e -> now.isAfter(e.getValue()));
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
