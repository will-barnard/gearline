package com.gearline.marketplace.shopify.webhook;

import com.gearline.domain.audit.AuditEventType;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.service.AuditService;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/webhooks/shopify")
@RequiredArgsConstructor
@Slf4j
@Tag(name = "Webhooks", description = "Shopify webhook receivers")
public class ShopifyWebhookController {

    private final ShopifyWebhookValidator webhookValidator;
    private final ShopifyWebhookProcessor webhookProcessor;
    private final AuditService auditService;

    @PostMapping("/inventory-levels/update")
    public ResponseEntity<Void> inventoryLevelUpdated(
        @RequestHeader("X-Shopify-Hmac-Sha256") String hmacHeader,
        @RequestHeader("X-Shopify-Shop-Domain") String shopDomain,
        @RequestHeader("X-Shopify-Topic") String topic,
        @RequestBody byte[] rawBody,
        HttpServletRequest request
    ) {
        return handleWebhook(topic, shopDomain, hmacHeader, rawBody);
    }

    @PostMapping("/products/update")
    public ResponseEntity<Void> productUpdated(
        @RequestHeader("X-Shopify-Hmac-Sha256") String hmacHeader,
        @RequestHeader("X-Shopify-Shop-Domain") String shopDomain,
        @RequestHeader("X-Shopify-Topic") String topic,
        @RequestBody byte[] rawBody
    ) {
        return handleWebhook(topic, shopDomain, hmacHeader, rawBody);
    }

    @PostMapping("/products/create")
    public ResponseEntity<Void> productCreated(
        @RequestHeader("X-Shopify-Hmac-Sha256") String hmacHeader,
        @RequestHeader("X-Shopify-Shop-Domain") String shopDomain,
        @RequestHeader("X-Shopify-Topic") String topic,
        @RequestBody byte[] rawBody
    ) {
        return handleWebhook(topic, shopDomain, hmacHeader, rawBody);
    }

    @PostMapping("/orders/create")
    public ResponseEntity<Void> orderCreated(
        @RequestHeader("X-Shopify-Hmac-Sha256") String hmacHeader,
        @RequestHeader("X-Shopify-Shop-Domain") String shopDomain,
        @RequestHeader("X-Shopify-Topic") String topic,
        @RequestBody byte[] rawBody
    ) {
        return handleWebhook(topic, shopDomain, hmacHeader, rawBody);
    }

    // ── Internal dispatch ──────────────────────────────────────────────────────

    private ResponseEntity<Void> handleWebhook(String topic, String shopDomain, String hmacHeader, byte[] rawBody) {
        // 1. Validate HMAC signature
        if (!webhookValidator.isValidSignature(rawBody, hmacHeader)) {
            log.warn("Invalid Shopify webhook signature from shop {} topic {}", shopDomain, topic);
            auditService.recordMarketplaceEvent(
                AuditEventType.WEBHOOK_SIGNATURE_INVALID, MarketplaceType.SHOPIFY,
                null, "Webhook", topic, false, "Invalid HMAC signature",
                Map.of("shop", shopDomain, "topic", topic)
            );
            return ResponseEntity.status(401).build();
        }

        // 2. Audit receipt
        auditService.recordMarketplaceEvent(
            AuditEventType.WEBHOOK_RECEIVED, MarketplaceType.SHOPIFY,
            null, "Webhook", topic, true, null,
            Map.of("shop", shopDomain, "topic", topic)
        );

        // 3. Async processing — always return 200 immediately to Shopify
        webhookProcessor.processAsync(topic, shopDomain, rawBody);

        return ResponseEntity.ok().build();
    }
}
