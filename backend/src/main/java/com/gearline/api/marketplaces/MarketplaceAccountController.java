package com.gearline.api.marketplaces;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.pricing.PricingProfile;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.PricingProfileRepository;
import com.gearline.marketplace.common.connector.MarketplaceConnectorRegistry;
import com.gearline.marketplace.common.connector.ConnectorHealthResult;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.reverb.client.ReverbApiClient;
import com.gearline.marketplace.shopify.sync.ShopifyInitialSyncService;
import com.gearline.service.ListingBackfillService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/marketplace/accounts")
@RequiredArgsConstructor
@Tag(name = "Marketplace Accounts", description = "Connected marketplace account management")
public class MarketplaceAccountController {

    private final MarketplaceAccountRepository accountRepository;
    private final MarketplaceConnectorRegistry connectorRegistry;
    private final PricingProfileRepository pricingProfileRepository;
    private final ShopifyInitialSyncService shopifyInitialSyncService;
    private final ReverbApiClient reverbApiClient;
    private final ListingBackfillService listingBackfillService;

    @GetMapping
    @Operation(summary = "List all connected marketplace accounts")
    public ResponseEntity<List<MarketplaceAccountDto>> listAccounts() {
        return ResponseEntity.ok(
            accountRepository.findAll().stream()
                .map(a -> MarketplaceAccountDto.from(a, resolveProfile(a)))
                .toList()
        );
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get a marketplace account by ID")
    public ResponseEntity<MarketplaceAccountDto> getAccount(@PathVariable UUID id) {
        MarketplaceAccount a = accountRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("MarketplaceAccount", id));
        return ResponseEntity.ok(MarketplaceAccountDto.from(a, resolveProfile(a)));
    }

    @PostMapping
    @Operation(summary = "Manually create a marketplace account (used for PAT-based connectors such as Reverb)")
    public ResponseEntity<MarketplaceAccountDto> createAccount(@Valid @RequestBody CreateMarketplaceAccountRequest req) {
        MarketplaceAccount account = MarketplaceAccount.builder()
            .marketplaceType(req.marketplaceType())
            .displayName(req.displayName())
            .encryptedCredentials(req.credentials())
            .connectionStatus(ConnectionStatus.CONNECTED)
            .build();
        account = accountRepository.save(account);
        // Backfill NEEDS_REVIEW stubs for products that existed before this account was connected.
        // Shopify is the product source, not a listing destination — skip it.
        if (account.getMarketplaceType() != MarketplaceType.SHOPIFY) {
            listingBackfillService.backfillListingsForNewAccount(account);
        }
        return ResponseEntity.created(URI.create("/api/v1/marketplace/accounts/" + account.getId()))
            .body(MarketplaceAccountDto.from(account));
    }

    @PostMapping("/{id}/health-check")
    @Operation(summary = "Test connectivity for a marketplace account")
    public ResponseEntity<ConnectorHealthResult> healthCheck(@PathVariable UUID id) {
        MarketplaceAccount account = accountRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("MarketplaceAccount", id));

        if (!connectorRegistry.hasConnector(account.getMarketplaceType())) {
            return ResponseEntity.ok(
                ConnectorHealthResult.unhealthy(account.getMarketplaceType(), "No connector registered")
            );
        }

        ConnectorHealthResult result = connectorRegistry.getConnector(account.getMarketplaceType())
            .checkHealth(account);

        account.setConnectionStatus(result.isHealthy() ? ConnectionStatus.CONNECTED : ConnectionStatus.ERROR);
        account.setLastError(result.isHealthy() ? null : result.getMessage());
        accountRepository.save(account);

        return ResponseEntity.ok(result);
    }

    @PatchMapping("/{id}/toggle")
    @Operation(summary = "Enable or disable a marketplace account")
    public ResponseEntity<MarketplaceAccountDto> toggleAccount(
        @PathVariable UUID id,
        @RequestParam boolean active
    ) {
        MarketplaceAccount account = accountRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("MarketplaceAccount", id));
        account.setActive(active);
        if (!active) {
            account.setConnectionStatus(ConnectionStatus.DISCONNECTED);
        }
        account = accountRepository.save(account);
        return ResponseEntity.ok(MarketplaceAccountDto.from(account, resolveProfile(account)));
    }

    @PostMapping("/{id}/sync-products")
    @Operation(summary = "Trigger a one-off bulk import of all active products from a Shopify store")
    public ResponseEntity<Map<String, String>> syncProducts(@PathVariable UUID id) {
        MarketplaceAccount account = accountRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("MarketplaceAccount", id));

        if (account.getMarketplaceType() != MarketplaceType.SHOPIFY) {
            return ResponseEntity.badRequest()
                .body(Map.of("error", "Product sync is only available for Shopify accounts"));
        }

        // Runs asynchronously — returns immediately while sync proceeds in background
        shopifyInitialSyncService.syncAllProducts(account);

        return ResponseEntity.accepted()
            .body(Map.of("message", "Product sync started. Products will appear in Gearline as they are imported."));
    }

    @PatchMapping("/{id}/pricing-profile")
    @Operation(summary = "Assign or clear the pricing profile for a marketplace account")
    public ResponseEntity<MarketplaceAccountDto> assignPricingProfile(
        @PathVariable UUID id,
        @RequestBody AssignPricingProfileRequest req
    ) {
        MarketplaceAccount account = accountRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("MarketplaceAccount", id));

        PricingProfile profile = null;
        if (req.pricingProfileId() != null) {
            profile = pricingProfileRepository.findById(req.pricingProfileId())
                .orElseThrow(() -> new ResourceNotFoundException("PricingProfile", req.pricingProfileId()));
        }
        account.setPricingProfileId(req.pricingProfileId());
        account = accountRepository.save(account);
        return ResponseEntity.ok(MarketplaceAccountDto.from(account, profile));
    }

    @GetMapping("/{id}/reverb/shipping-profiles")
    @Operation(summary = "Fetch shipping profiles saved on the seller's Reverb account")
    public ResponseEntity<List<Map<String, Object>>> getReverbShippingProfiles(@PathVariable UUID id) {
        MarketplaceAccount account = accountRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("MarketplaceAccount", id));

        if (account.getMarketplaceType() != MarketplaceType.REVERB) {
            return ResponseEntity.badRequest().build();
        }

        // Fetch from Reverb and slim down to just id + name — the ID is what
        // gets sent as shipping_profile_id when publishing a listing.
        List<Map<String, Object>> all = reverbApiClient.getShippingProfiles(account);
        List<Map<String, Object>> slimmed = all.stream()
            .filter(p -> p.get("id") != null && p.get("name") != null)
            .map(p -> Map.<String, Object>of("id", p.get("id"), "name", p.get("name")))
            .toList();

        return ResponseEntity.ok(slimmed);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private PricingProfile resolveProfile(MarketplaceAccount a) {
        if (a.getPricingProfileId() == null) return null;
        return pricingProfileRepository.findById(a.getPricingProfileId()).orElse(null);
    }

    @PatchMapping("/{id}/settings")
    @Operation(summary = "Update sync settings for a marketplace account (e.g. excluded tags)")
    public ResponseEntity<MarketplaceAccountDto> updateSettings(
        @PathVariable UUID id,
        @RequestBody UpdateAccountSettingsRequest req
    ) {
        MarketplaceAccount account = accountRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("MarketplaceAccount", id));

        if (account.getSyncSettings() == null) {
            account.setSyncSettings(new java.util.HashMap<>());
        }

        if (req.excludedTags() != null) {
            // Normalise: lowercase + strip whitespace, then deduplicate
            List<String> normalised = req.excludedTags().stream()
                .map(String::strip)
                .map(String::toLowerCase)
                .filter(t -> !t.isBlank())
                .distinct()
                .toList();
            account.getSyncSettings().put("excluded_tags", new ArrayList<>(normalised));
        }

        // description_suffix: store as-is (allow blank to clear it)
        if (req.descriptionSuffix() != null) {
            String suffix = req.descriptionSuffix().strip();
            if (suffix.isBlank()) {
                account.getSyncSettings().remove("description_suffix");
            } else {
                account.getSyncSettings().put("description_suffix", suffix);
            }
        }

        account = accountRepository.save(account);
        return ResponseEntity.ok(MarketplaceAccountDto.from(account, resolveProfile(account)));
    }

    // ── Inner request records ──────────────────────────────────────────────────

    public record CreateMarketplaceAccountRequest(
        MarketplaceType marketplaceType,
        @NotBlank String displayName,
        Map<String, String> credentials
    ) {}

    public record AssignPricingProfileRequest(UUID pricingProfileId) {}

    public record UpdateAccountSettingsRequest(
        List<String> excludedTags,
        String descriptionSuffix
    ) {}
}
