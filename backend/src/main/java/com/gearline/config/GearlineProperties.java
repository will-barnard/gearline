package com.gearline.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "gearline")
@Data
public class GearlineProperties {

    private Jwt jwt = new Jwt();
    private App app = new App();
    private Credential credential = new Credential();
    private Shopify shopify = new Shopify();
    private Reverb reverb = new Reverb();
    private Ebay ebay = new Ebay();
    private Sync sync = new Sync();
    private Queue queue = new Queue();

    @Data
    public static class Jwt {
        private String secret;
        private long accessTokenExpiryMs = 900_000L;
        private long refreshTokenExpiryMs = 604_800_000L;
    }

    @Data
    public static class App {
        private String baseUrl;
    }

    @Data
    public static class Credential {
        /**
         * Base64-encoded 32-byte AES-256 key for encrypting marketplace OAuth tokens at rest.
         * Generate with: openssl rand -base64 32
         * If blank, credentials are stored as plain JSON (dev/CI mode — not for production).
         */
        private String encryptionKey;
    }

    @Data
    public static class Shopify {
        private String clientId;
        private String clientSecret;
        private String scopes;

        /**
         * Static secret for Shopify Flows "Send HTTP Request" actions.
         * Flows does not sign requests with HMAC — instead you configure a static
         * token in the Flow and Gearline compares the incoming header value against this.
         * Set via SHOPIFY_FLOW_SECRET environment variable.
         */
        private String flowSecret;

        /**
         * Name of the HTTP header Shopify Flows will send the token in.
         * You configure this header name in your Flow's "Send HTTP Request" action.
         * Defaults to X-Shopify-Flow-Token.
         * Set via SHOPIFY_FLOW_TOKEN_HEADER environment variable (optional).
         */
        private String flowTokenHeader = "X-Shopify-Flow-Token";
    }

    @Data
    public static class Reverb {
        private String clientId;
        private String clientSecret;
        private String apiBaseUrl;
        private String authUrl;
    }

    @Data
    public static class Ebay {
        private String clientId;
        private String clientSecret;
        private String apiBaseUrl;
        private String authUrl;

        /**
         * eBay RuName (Redirect URL Name) — a short string assigned by eBay when you
         * register a redirect URL in the eBay Developer Portal.
         * It looks like: YourApp-YourApp-12345-abcde
         * Used as the redirect_uri parameter in both the authorization URL and token exchange.
         * Set via EBAY_RU_NAME environment variable.
         */
        private String ruName;
    }

    @Data
    public static class Sync {
        private int maxRetryAttempts = 5;
        private long initialRetryDelayMs = 1000L;
        private long maxRetryDelayMs = 300_000L;
    }

    @Data
    public static class Queue {
        private String syncExchange;
        private String syncQueue;
        private String dlxExchange;
        private String dlqName;
        private long retryDelayMs;
    }
}
