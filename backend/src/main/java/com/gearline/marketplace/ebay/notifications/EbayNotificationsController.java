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
 *   https://developer.ebay.com/marketplace-account-deletion
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Verification flow (one-time, triggered from the Developer Portal)
 * ──────────────────────────────────────────────────────────────────────────
 * 1. In the portal, enter this endpoint URL and a verification token.
 * 2. eBay sends:
 *      GET /api/v1/marketplace/ebay/notifications?challenge_code=<random>
 * 3. This handler responds with:
 *      {"challengeResponse": "<sha256hex>"}
 *    where sha256hex = SHA-256( challengeCode + verificationToken + endpointUrl )
 *    — concatenated in that exact order, no delimiters.
 * 4. eBay validates the hash; on match the endpoint is marked as verified
 *    and the keyset is enabled.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Runtime notifications
 * ──────────────────────────────────────────────────────────────────────────
 * After verification, eBay POSTs a JSON event body whenever a buyer
 * requests account deletion. Gearline logs the notification and returns 200.
 * No buyer order/listing data is stored by Gearline so no further scrubbing
 * is required, but you may extend the POST handler if you add PII storage.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Configuration (env vars)
 * ──────────────────────────────────────────────────────────────────────────
 *   EBAY_NOTIFICATION_VERIFICATION_TOKEN — any string you choose; enter the
 *     same value in the portal under Application Keys → Notifications.
 *   APP_BASE_URL — used to reconstruct the full endpoint URL for the hash.
 *     Must match exactly what you register in the portal.
 */
@RestController
@RequestMapping("/api/v1/marketplace/ebay/notifications")
@RequiredArgsConstructor
@Slf4j
public class EbayNotificationsController {

    /** Path segment appended to APP_BASE_URL to form the full endpoint URL. */
    static final String ENDPOINT_PATH = "/api/v1/marketplace/ebay/notifications";

    private final GearlineProperties properties;

    // ── Challenge verification (GET) ──────────────────────────────────────────

    /**
     * Responds to eBay's one-time challenge used to verify endpoint ownership.
     *
     * Called by the "Send Test Notification / Verify" button in the Developer Portal.
     * Must return HTTP 200 with Content-Type application/json and body:
     *   {"challengeResponse": "<sha256hex>"}
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

        // Reconstruct the endpoint URL exactly as registered in the portal
        String baseUrl = properties.getApp().getBaseUrl();
        if (baseUrl == null || baseUrl.isBlank()) {
            baseUrl = "http://localhost:8080";
        }
        String endpointUrl = baseUrl.replaceAll("/$", "") + ENDPOINT_PATH;

        // SHA-256( challengeCode + verificationToken + endpointUrl ) — no delimiters
        String hash = sha256Hex(challengeCode + verificationToken + endpointUrl);

        log.info("eBay challenge verification — endpoint={} hash={}", endpointUrl, hash);
        return ResponseEntity.ok(Map.of("challengeResponse", hash));
    }

    // ── Deletion notification (POST) ──────────────────────────────────────────

    /**
     * Receives eBay account-deletion events after the endpoint has been verified.
     *
     * Gearline does not store buyer PII, so we simply acknowledge the notification.
     * If buyer data is ever added (e.g. order history linked to buyer accounts),
     * implement scrubbing logic here.
     */
    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> receiveNotification(@RequestBody(required = false) String body) {
        log.info("eBay account-deletion notification received: {}", body);
        // Acknowledge with 200 — eBay will retry on any non-2xx response
        return ResponseEntity.ok().build();
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private static String sha256Hex(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }
}
