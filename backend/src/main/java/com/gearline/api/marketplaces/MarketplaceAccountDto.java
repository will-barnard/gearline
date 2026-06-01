package com.gearline.api.marketplaces;

import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.pricing.PricingProfile;
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
    Instant createdAt,
    UUID pricingProfileId,
    String pricingProfileName
) {
    /** Use when PricingProfile entity is already available (avoids extra DB lookup). */
    public static MarketplaceAccountDto from(MarketplaceAccount a, PricingProfile profile) {
        return new MarketplaceAccountDto(
            a.getId(), a.getMarketplaceType(), a.getDisplayName(),
            a.getExternalAccountId(), a.getExternalShopUrl(), a.getActive(),
            a.getConnectionStatus(), a.getLastSyncAt(), a.getLastError(), a.getCreatedAt(),
            profile != null ? profile.getId() : null,
            profile != null ? profile.getName() : null
            // NOTE: encryptedCredentials deliberately omitted from DTO
        );
    }

    /** Convenience overload when no profile is loaded (profile fields will be null). */
    public static MarketplaceAccountDto from(MarketplaceAccount a) {
        return from(a, null);
    }
}
