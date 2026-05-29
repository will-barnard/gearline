package com.gearline.api.marketplaces;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.marketplace.common.connector.MarketplaceConnectorRegistry;
import com.gearline.marketplace.common.connector.ConnectorHealthResult;
import com.gearline.marketplace.common.connector.MarketplaceType;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/marketplace/accounts")
@RequiredArgsConstructor
@Tag(name = "Marketplace Accounts", description = "Connected marketplace account management")
public class MarketplaceAccountController {

    private final MarketplaceAccountRepository accountRepository;
    private final MarketplaceConnectorRegistry connectorRegistry;

    @GetMapping
    @Operation(summary = "List all connected marketplace accounts")
    public ResponseEntity<List<MarketplaceAccountDto>> listAccounts() {
        return ResponseEntity.ok(
            accountRepository.findAll().stream().map(MarketplaceAccountDto::from).toList()
        );
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get a marketplace account by ID")
    public ResponseEntity<MarketplaceAccountDto> getAccount(@PathVariable UUID id) {
        return ResponseEntity.ok(MarketplaceAccountDto.from(
            accountRepository.findById(id).orElseThrow(() -> new ResourceNotFoundException("MarketplaceAccount", id))
        ));
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
        return ResponseEntity.ok(MarketplaceAccountDto.from(accountRepository.save(account)));
    }
}
