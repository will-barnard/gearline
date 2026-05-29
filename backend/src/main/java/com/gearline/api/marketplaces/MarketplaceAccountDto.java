package com.gearline.api.marketplaces;

import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.marketplace.common.connector.MarketplaceType;

import java.time.Instant;
import java.util.UUID;

public record MarketplaceAccountDto(
    UUID id,
    MarketplaceType marketplaceType,
    String displayName,
    String externalAccountId,
    String externalShopUrl,
    Boolean active,
    ConnectionStatus connectionStatus,
    Instant lastSyncAt,
    String lastError,
    Instant createdAt
) {
    public static MarketplaceAccountDto from(MarketplaceAccount a) {
        return new MarketplaceAccountDto(
            a.getId(), a.getMarketplaceType(), a.getDisplayName(),
            a.getExternalAccountId(), a.getExternalShopUrl(), a.getActive(),
            a.getConnectionStatus(), a.getLastSyncAt(), a.getLastError(), a.getCreatedAt()
            // NOTE: encryptedCredentials deliberately omitted from DTO
        );
    }
}
