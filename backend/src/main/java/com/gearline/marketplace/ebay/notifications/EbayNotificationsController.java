package com.gearline.marketplace.ebay.notifications;

import com.gearline.config.GearlineProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;

/**
 * eBay Marketplace Account Deletion / Data Erasure Notifications.
 *
 * eBay requires all developer apps to register an endpoint that receives
 * account-deletion events (GDPR / CCPA compliance). Without a verified
 * endpoint the developer keyset remains disabled.
 *
 * Reference:
 *   https://developer.ebay.com/develop/guides-v2/marketplace-user-account-deletion
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Verification flow (one-time, triggered from the Developer Portal)
 * ──────────────────────────────────────────────────────────────────────────
 * 1. In the portal (Alerts & Notifications), enter:
 *      Notification Endpoint URL: https://yourdomain.com/api/v1/marketplace/ebay/notifications
 *      Verification token:        <EBAY_NOTIFICATION_VERIFICATION_TOKEN value>
 * 2. eBay immediately sends:
 *      GET /api/v1/marketplace/ebay/notifications?challenge_code=<random>
 * 3. This handler responds with:
 *      {"challengeResponse": "<sha256hex>"}
 *    where sha256hex = SHA-256( challengeCode bytes || verificationToken bytes || endpointUrl bytes )
 *    per eBay's official Java sample (incremental digest updates, no delimiter).
 * 4. eBay validates the hash; on match the endpoint is verified and the keyset is enabled.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Verification token constraints (eBay enforced)
 * ──────────────────────────────────────────────────────────────────────────
 *   - 32–80 characters
 *   - Only alphanumeric characters, underscore (_), and hyphen (-) allowed
 *   - Generate safely with: LC_ALL=C tr -dc 'a-zA-Z0-9_-' </dev/urandom | head -c 64
 *     (avoid openssl rand -base64 — produces +, /, = which eBay rejects)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Configuration (env vars)
 * ──────────────────────────────────────────────────────────────────────────
 *   EBAY_NOTIFICATION_VERIFICATION_TOKEN — token chosen by you; paste the
 *     exact same value in the portal Verification token field.
 *   APP_BASE_URL — the public HTTPS base URL of your deployment (no trailing
 *     slash). The endpoint URL used in the hash is APP_BASE_URL + ENDPOINT_PATH.
 *     This must exactly match what you typed into the portal.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Debug endpoint (no auth required)
 * ──────────────────────────────────────────────────────────────────────────
 * GET /api/v1/marketplace/ebay/notifications/debug
 * Returns the endpoint URL the backend will use in hash computation and
 * whether the verification token is configured. Use this to confirm the URL
 * exactly matches what you entered in the Developer Portal.
 */
@RestController
@RequestMapping("/api/v1/marketplace/ebay/notifications")
@RequiredArgsConstructor
@Slf4j
public class EbayNotificationsController {

    /** Path appended to APP_BASE_URL to form the registered endpoint URL. */
    static final String ENDPOINT_PATH = "/api/v1/marketplace/ebay/notifications";

    private final GearlineProperties properties;

    // ── Challenge verification (GET) ──────────────────────────────────────────

    /**
     * Responds to eBay's one-time endpoint ownership challenge.
     *
     * eBay sends GET ?challenge_code=xxx immediately when you save the endpoint
     * URL in the portal. Returns HTTP 200 + application/json:
     *   {"challengeResponse": "<sha256hex>"}
     *
     * Hash algorithm (from eBay's official Java sample):
     *   digest.update(challengeCode bytes)
     *   digest.update(verificationToken bytes)
     *   digest.digest(endpointUrl bytes)
     */
    @GetMapping(produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, String>> challenge(
        @RequestParam(name = "challenge_code") String challengeCode
    ) {
        String verificationToken = properties.getEbay().getNotificationVerificationToken();
        if (verificationToken == null || verificationToken.isBlank()) {
            log.error("EBAY_NOTIFICATION_VERIFICATION_TOKEN is not configured — " +
                "set it to the same value you entered in the Developer Portal");
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                "EBAY_NOTIFICATION_VERIFICATION_TOKEN is not configured");
        }

        String endpointUrl = computeEndpointUrl();

        // Incremental SHA-256 updates — matches eBay's official Java sample exactly:
        //   digest.update(challengeCode.getBytes(UTF_8));
        //   digest.update(verificationToken.getBytes(UTF_8));
        //   byte[] bytes = digest.digest(endpoint.getBytes(UTF_8));
        String hash = sha256Hex(challengeCode, verificationToken, endpointUrl);

        log.info("eBay challenge verification — endpointUrl='{}' challengeCode='{}' hash='{}'",
            endpointUrl, challengeCode, hash);

        return ResponseEntity.ok(Map.of("challengeResponse", hash));
    }

    // ── Deletion notification (POST) ──────────────────────────────────────────

    /**
     * Receives eBay account-deletion events after the endpoint has been verified.
     * Accepts any content type — eBay test notifications may omit Content-Type.
     *
     * Gearline does not store buyer PII, so we simply acknowledge.
     * Extend this handler if buyer-identifying data is added to the data model.
     */
    @PostMapping
    public ResponseEntity<Void> receiveNotification(
        @RequestBody(required = false) String body
    ) {
        log.info("eBay account-deletion notification received: {}", body);
        return ResponseEntity.ok().build();
    }

    // ── Debug endpoint ────────────────────────────────────────────────────────

    /**
     * Returns configuration status to help diagnose verification failures.
     *
     * Check that the "endpointUrl" value here exactly matches what you typed
     * into the Developer Portal's Notification Endpoint field.
     */
    @GetMapping("/debug")
    public ResponseEntity<Map<String, Object>> debug() {
        String token = properties.getEbay().getNotificationVerificationToken();
        String endpointUrl = computeEndpointUrl();
        return ResponseEntity.ok(Map.of(
            "endpointUrl", endpointUrl,
            "tokenConfigured", (token != null && !token.isBlank()),
            "tokenLength", (token != null ? token.length() : 0),
            "appBaseUrl", String.valueOf(properties.getApp().getBaseUrl())
        ));
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private String computeEndpointUrl() {
        String baseUrl = properties.getApp().getBaseUrl();
        if (baseUrl == null || baseUrl.isBlank()) {
            baseUrl = "http://localhost:8080";
        }
        return baseUrl.replaceAll("/$", "") + ENDPOINT_PATH;
    }

    /**
     * Computes SHA-256 using incremental updates — exactly matching eBay's official
     * Java code sample:
     *   digest.update(challengeCode.getBytes(UTF_8));
     *   digest.update(verificationToken.getBytes(UTF_8));
     *   byte[] bytes = digest.digest(endpoint.getBytes(UTF_8));
     */
    private static String sha256Hex(String challengeCode, String verificationToken, String endpoint) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(challengeCode.getBytes(StandardCharsets.UTF_8));
            digest.update(verificationToken.getBytes(StandardCharsets.UTF_8));
            byte[] bytes = digest.digest(endpoint.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }
}
