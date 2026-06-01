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
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
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

    // ── Helpers ────────────────────────────────────────────────────────────────

    private PricingProfile resolveProfile(MarketplaceAccount a) {
        if (a.getPricingProfileId() == null) return null;
        return pricingProfileRepository.findById(a.getPricingProfileId()).orElse(null);
    }

    // ── Inner request records ──────────────────────────────────────────────────

    public record CreateMarketplaceAccountRequest(
        MarketplaceType marketplaceType,
        @NotBlank String displayName,
        Map<String, String> credentials
    ) {}

    public record AssignPricingProfileRequest(UUID pricingProfileId) {}
}
