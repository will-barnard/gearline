package com.gearline.marketplace.shopify.webhook;

import com.gearline.config.GearlineProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

/**
 * Validates incoming Shopify requests.
 *
 * Two authentication schemes are supported:
 *
 * 1. Standard webhooks (products, inventory, orders)
 *    Header: X-Shopify-Hmac-Sha256 (Base64-encoded HMAC-SHA256 of the raw body)
 *    Secret: SHOPIFY_CLIENT_SECRET
 *
 * 2. Shopify Flows "Send HTTP Request" actions
 *    Header: configurable (default X-Shopify-Flow-Token); plain static token value
 *    Secret: SHOPIFY_FLOW_SECRET
 *
 *    Flows does not sign payloads with HMAC — the token is transmitted as-is.
 *    You set both the header name and the token value in your Flow's
 *    "Send HTTP Request" action configuration, and mirror them here via env vars.
 *    Constant-time comparison is used to prevent timing attacks on both paths.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ShopifyWebhookValidator {

    private final GearlineProperties properties;

    /**
     * Validates the HMAC-SHA256 signature of a standard Shopify webhook payload.
     * Uses constant-time comparison to prevent timing attacks.
     */
    public boolean isValidSignature(byte[] payload, String hmacHeader) {
        try {
            String clientSecret = properties.getShopify().getClientSecret();
            if (clientSecret == null || clientSecret.isBlank()) {
                log.warn("Shopify client secret not configured — webhook signature validation skipped");
                return true; // Allow in dev when secret is not set
            }

            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(clientSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(payload);
            String computed = Base64.getEncoder().encodeToString(digest);

            return MessageDigest.isEqual(
                computed.getBytes(StandardCharsets.UTF_8),
                hmacHeader.getBytes(StandardCharsets.UTF_8)
            );
        } catch (Exception e) {
            log.error("Error validating Shopify webhook signature", e);
            return false;
        }
    }

    /**
     * Validates a Shopify Flows static token.
     *
     * The header name that carries the token is configured via
     * {@code gearline.shopify.flow-token-header} (default: X-Shopify-Flow-Token).
     * The expected token value is configured via {@code gearline.shopify.flow-secret}.
     *
     * @param incomingToken the value of the Flow token header from the request
     * @return true if the token matches the configured secret
     */
    public boolean isValidFlowToken(String incomingToken) {
        String flowSecret = properties.getShopify().getFlowSecret();
        if (flowSecret == null || flowSecret.isBlank()) {
            log.warn("SHOPIFY_FLOW_SECRET not configured — Flows token validation skipped");
            return true; // Allow in dev when secret is not set
        }
        if (incomingToken == null || incomingToken.isBlank()) {
            return false;
        }
        // Constant-time comparison — token is a plain string, not Base64
        return MessageDigest.isEqual(
            flowSecret.getBytes(StandardCharsets.UTF_8),
            incomingToken.getBytes(StandardCharsets.UTF_8)
        );
    }

    /**
     * Returns the configured Flow token header name.
     * Used by the controller to extract the token from the request dynamically.
     */
    public String getFlowTokenHeaderName() {
        String header = properties.getShopify().getFlowTokenHeader();
        return (header != null && !header.isBlank()) ? header : "X-Shopify-Flow-Token";
    }
}
