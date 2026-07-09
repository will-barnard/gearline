package com.gearline.api.marketplaces;

import com.gearline.domain.marketplace.ConnectionStatus;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.pricing.PricingProfile;
import com.gearline.marketplace.common.connector.MarketplaceType;

import java.time.Instant;
import java.util.Collections;
import java.util.List;
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
    String pricingProfileName,
    /**
     * Tags (from the Shopify product's "Tags" field) that suppress marketplace
     * listing creation. Stored in syncSettings["excluded_tags"]. Shopify-specific;
     * will be empty for Reverb and eBay accounts.
     */
    List<String> excludedTags,
    /**
     * Free-text suffix appended to every listing description for this account,
     * separated by two newlines. Stored in syncSettings["description_suffix"].
     * Useful for adding boilerplate like shipping notes to all listings.
     */
    String descriptionSuffix
) {
    /** Use when PricingProfile entity is already available (avoids extra DB lookup). */
    public static MarketplaceAccountDto from(MarketplaceAccount a, PricingProfile profile) {
        List<String> excluded = Collections.emptyList();
        Object rawTags = a.getSyncSettings() != null ? a.getSyncSettings().get("excluded_tags") : null;
        if (rawTags instanceof List<?> list) {
            excluded = list.stream().map(Object::toString).toList();
        }
        String suffix = null;
        Object rawSuffix = a.getSyncSettings() != null ? a.getSyncSettings().get("description_suffix") : null;
        if (rawSuffix instanceof String s && !s.isBlank()) {
            suffix = s;
        }
        return new MarketplaceAccountDto(
            a.getId(), a.getMarketplaceType(), a.getDisplayName(),
            a.getExternalAccountId(), a.getExternalShopUrl(), a.getActive(),
            a.getConnectionStatus(), a.getLastSyncAt(), a.getLastError(), a.getCreatedAt(),
            profile != null ? profile.getId() : null,
            profile != null ? profile.getName() : null,
            // NOTE: encryptedCredentials deliberately omitted from DTO
            excluded,
            suffix
        );
    }

    /** Convenience overload when no profile is loaded (profile fields will be null). */
    public static MarketplaceAccountDto from(MarketplaceAccount a) {
        return from(a, null);
    }
}
