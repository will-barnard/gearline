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
     */
    String descriptionSuffix,
    /**
     * eBay account-level defaults. Stored in syncSettings and applied automatically
     * to every eBay listing that doesn't have a per-listing override for these fields.
     */
    String ebayMerchantLocationKey,
    String ebayFulfillmentPolicyId,
    String ebayReturnPolicyId
) {
    /** Use when PricingProfile entity is already available (avoids extra DB lookup). */
    public static MarketplaceAccountDto from(MarketplaceAccount a, PricingProfile profile) {
        List<String> excluded = Collections.emptyList();
        Object rawTags = a.getSyncSettings() != null ? a.getSyncSettings().get("excluded_tags") : null;
        if (rawTags instanceof List<?> list) {
            excluded = list.stream().map(Object::toString).toList();
        }

        String suffix = stringSetting(a, "description_suffix");
        String locationKey = stringSetting(a, "ebay_merchant_location_key");
        String fulfillmentId = stringSetting(a, "ebay_fulfillment_policy_id");
        String returnId = stringSetting(a, "ebay_return_policy_id");

        return new MarketplaceAccountDto(
            a.getId(), a.getMarketplaceType(), a.getDisplayName(),
            a.getExternalAccountId(), a.getExternalShopUrl(), a.getActive(),
            a.getConnectionStatus(), a.getLastSyncAt(), a.getLastError(), a.getCreatedAt(),
            profile != null ? profile.getId() : null,
            profile != null ? profile.getName() : null,
            excluded,
            suffix,
            locationKey,
            fulfillmentId,
            returnId
        );
    }

    /** Convenience overload when no profile is loaded (profile fields will be null). */
    public static MarketplaceAccountDto from(MarketplaceAccount a) {
        return from(a, null);
    }

    private static String stringSetting(MarketplaceAccount a, String key) {
        Object raw = a.getSyncSettings() != null ? a.getSyncSettings().get(key) : null;
        return (raw instanceof String s && !s.isBlank()) ? s : null;
    }
}
