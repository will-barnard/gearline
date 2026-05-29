package com.gearline.marketplace.shopify.webhook;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gearline.domain.audit.AuditEventType;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.service.AuditService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * Receives HTTP requests sent by Shopify Flows automations.
 *
 * Shopify Flows lets merchants build no-code automations triggered by store events.
 * The "Send HTTP Request" action can call this endpoint, but it does NOT use the
 * standard Shopify HMAC signature scheme. Instead, authentication is a static token
 * that you configure once in the Flow and mirror here via the SHOPIFY_FLOW_SECRET
 * environment variable.
 *
 * ── Setup in Shopify Flows ──────────────────────────────────────────────────
 *
 *   1. In your Flow's "Send HTTP Request" action, set:
 *        URL:     https://your-domain/webhooks/shopify/flows
 *        Method:  POST
 *        Header:  X-Shopify-Flow-Token  →  <same value as SHOPIFY_FLOW_SECRET>
 *                 (header name is configurable via SHOPIFY_FLOW_TOKEN_HEADER)
 *        Body:    a JSON template containing at minimum:
 *                   { "topic": "product_activated",
 *                     "shopify_product_id": "{{product.id}}" }
 *
 *   2. In Beachhead dashboard, set:
 *        SHOPIFY_FLOW_SECRET        = your chosen static token
 *        SHOPIFY_FLOW_TOKEN_HEADER  = X-Shopify-Flow-Token  (optional, this is the default)
 *
 * ── Payload format ──────────────────────────────────────────────────────────
 *
 * The Flow body is freely templated by the merchant. Gearline looks for these
 * well-known keys to trigger specific actions:
 *
 *   topic               — string, e.g. "product_activated", "listing_requested"
 *   shopify_product_id  — if present, the processor tries to flag/create listings
 *   shop_domain         — Shopify store domain (mystore.myshopify.com)
 *
 * Any payload that does not match known keys is accepted (200) and audit-logged.
 * This lets you use Flows for notification-only payloads without errors.
 */
@RestController
@RequestMapping("/webhooks/shopify/flows")
@RequiredArgsConstructor
@Slf4j
@Tag(name = "Webhooks", description = "Shopify webhook receivers")
public class ShopifyFlowWebhookController {

    private final ShopifyWebhookValidator webhookValidator;
    private final ShopifyWebhookProcessor webhookProcessor;
    private final AuditService auditService;
    private final ObjectMapper objectMapper;

    @PostMapping
    @Operation(summary = "Receive a Shopify Flows HTTP request action")
    public ResponseEntity<Void> receiveFlowEvent(
        @RequestBody byte[] rawBody,
        HttpServletRequest request
    ) {
        // ── 1. Extract and validate the static Flow token ─────────────────────
        String headerName = webhookValidator.getFlowTokenHeaderName();
        String incomingToken = request.getHeader(headerName);

        if (!webhookValidator.isValidFlowToken(incomingToken)) {
            log.warn("Invalid Shopify Flow token on header '{}'", headerName);
            auditService.recordMarketplaceEvent(
                AuditEventType.WEBHOOK_SIGNATURE_INVALID, MarketplaceType.SHOPIFY,
                null, "FlowWebhook", "flows", false,
                "Invalid Flow token on header: " + headerName, Map.of()
            );
            return ResponseEntity.status(401).build();
        }

        // ── 2. Parse the payload ──────────────────────────────────────────────
        JsonNode payload;
        try {
            payload = objectMapper.readTree(rawBody);
        } catch (Exception e) {
            log.warn("Shopify Flow webhook: could not parse JSON body — {}", e.getMessage());
            return ResponseEntity.badRequest().build();
        }

        String topic = payload.path("topic").asText("unknown");
        String shopDomain = payload.path("shop_domain").asText("unknown");

        log.info("Shopify Flow event received: topic={} shop={}", topic, shopDomain);

        // ── 3. Audit receipt ──────────────────────────────────────────────────
        auditService.recordMarketplaceEvent(
            AuditEventType.WEBHOOK_RECEIVED, MarketplaceType.SHOPIFY,
            null, "FlowWebhook", topic, true, null,
            Map.of("shop", shopDomain, "topic", topic, "source", "flows")
        );

        // ── 4. Route to processor if a product ID is present ─────────────────
        String shopifyProductId = payload.path("shopify_product_id").asText();
        if (!shopifyProductId.isBlank()) {
            // Re-use the products/create path so the product is upserted and
            // NEEDS_REVIEW listings are created for all connected accounts.
            // Build a minimal synthetic payload matching the products/create format.
            webhookProcessor.processAsync("products/create", shopDomain, buildSyntheticProductPayload(payload));
        } else {
            log.debug("Shopify Flow event has no shopify_product_id — audit-logged only");
        }

        // ── 5. Always return 200 immediately so Flows doesn't retry ──────────
        return ResponseEntity.ok().build();
    }

    /**
     * Builds a minimal products/create-compatible JSON payload from a Flow body.
     * This lets us re-use {@link ShopifyWebhookProcessor#processAsync} without
     * a separate code path for Flow-triggered product events.
     */
    private byte[] buildSyntheticProductPayload(JsonNode flowPayload) {
        try {
            var builder = objectMapper.createObjectNode();
            builder.put("id", flowPayload.path("shopify_product_id").asText());

            // Copy any fields that the Flow action may have templated in
            if (flowPayload.has("title"))       builder.put("title", flowPayload.path("title").asText());
            if (flowPayload.has("body_html"))    builder.put("body_html", flowPayload.path("body_html").asText());
            if (flowPayload.has("vendor"))       builder.put("vendor", flowPayload.path("vendor").asText());

            // Build a minimal variants array if variant data was included
            var variants = builder.putArray("variants");
            var variant = variants.addObject();
            variant.put("id", flowPayload.path("shopify_variant_id").asText(""));
            variant.put("sku", flowPayload.path("sku").asText(""));
            variant.put("price", flowPayload.path("price").asText("0.00"));
            variant.put("inventory_item_id", flowPayload.path("shopify_inventory_item_id").asText(""));
            variant.put("inventory_quantity", flowPayload.path("inventory_quantity").asInt(0));

            return objectMapper.writeValueAsBytes(builder);
        } catch (Exception e) {
            log.error("Failed to build synthetic product payload from Flow body", e);
            return "{}".getBytes();
        }
    }
}
