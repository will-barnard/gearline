package com.gearline.service;

import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.marketplace.common.connector.MarketplaceType;
import com.gearline.marketplace.common.dto.PublishListingRequest;
import com.gearline.marketplace.common.dto.ShippingDetails;
import com.gearline.marketplace.common.util.ShippingCalculator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * Verifies that ListingAttributeResolver correctly merges product defaults with
 * listing_overrides and produces a fully typed PublishListingRequest.
 */
class ListingAttributeResolverTest {

    private ShippingCalculator shippingCalculator;
    private ListingAttributeResolver resolver;

    @BeforeEach
    void setUp() {
        shippingCalculator = mock(ShippingCalculator.class);
        resolver = new ListingAttributeResolver(shippingCalculator);

        // Default: return a simple shipping details object for all invocations
        when(shippingCalculator.resolveShipping(any(), any()))
            .thenReturn(ShippingDetails.builder().weightOz(new BigDecimal("64.0")).build());
    }

    // ── Core field resolution ──────────────────────────────────────────────────

    @Test
    void quantity_alwaysTakenFromProduct() {
        PublishListingRequest req = resolver.resolve(buildProduct(5), listingWith(Map.of()));
        assertThat(req.getQuantity()).isEqualTo(5);
    }

    @Test
    void titleOverride_usedWhenPresent_notWhenAbsent() {
        // With override
        PublishListingRequest withOverride = resolver.resolve(
            buildProduct(1),
            listingWith(Map.of("title", "Custom Title"))
        );
        assertThat(withOverride.getTitleOverride()).isEqualTo("Custom Title");

        // Without override — field should be null (connector falls back to product.title)
        PublishListingRequest withoutOverride = resolver.resolve(
            buildProduct(1),
            listingWith(Map.of())
        );
        assertThat(withoutOverride.getTitleOverride()).isNull();
    }

    @Test
    void priceOverride_parsedFromDecimalString() {
        PublishListingRequest req = resolver.resolve(
            buildProduct(1),
            listingWith(Map.of("price", "1299.99"))
        );
        assertThat(req.getPriceOverride()).isEqualByComparingTo("1299.99");
    }

    @Test
    void priceOverride_null_whenNotSet() {
        PublishListingRequest req = resolver.resolve(buildProduct(1), listingWith(Map.of()));
        assertThat(req.getPriceOverride()).isNull();
    }

    @Test
    void priceOverride_null_whenValueIsInvalidDecimal() {
        // Malformed decimal should be ignored gracefully
        PublishListingRequest req = resolver.resolve(
            buildProduct(1),
            listingWith(Map.of("price", "not-a-number"))
        );
        assertThat(req.getPriceOverride()).isNull();
    }

    @Test
    void categoryId_setFromOverride() {
        PublishListingRequest req = resolver.resolve(
            buildProduct(1),
            listingWith(Map.of("category_id", "reverb-cat-uuid"))
        );
        assertThat(req.getCategoryId()).isEqualTo("reverb-cat-uuid");
    }

    // ── Image URL resolution ───────────────────────────────────────────────────

    @Test
    void imageUrls_fallBackToProductUrls_whenNoOverride() {
        Product product = buildProduct(1).toBuilder()
            .imageUrls(List.of("https://example.com/img1.jpg"))
            .build();
        PublishListingRequest req = resolver.resolve(product, listingWith(Map.of()));
        assertThat(req.getImageUrls()).containsExactly("https://example.com/img1.jpg");
    }

    @Test
    void imageUrls_overrideReplacesProductUrls() {
        Product product = buildProduct(1).toBuilder()
            .imageUrls(List.of("https://example.com/old.jpg"))
            .build();
        PublishListingRequest req = resolver.resolve(
            product,
            listingWith(Map.of("image_urls", List.of("https://example.com/new.jpg")))
        );
        assertThat(req.getImageUrls()).containsExactly("https://example.com/new.jpg");
    }

    // ── Passthrough (extraParams) ──────────────────────────────────────────────

    @Test
    void extraParams_containsUnrecognisedKeys_notResolvedOnes() {
        Map<String, Object> overrides = new HashMap<>();
        overrides.put("price", "500.00");           // resolved → priceOverride
        overrides.put("reverb_model", "Stratocaster"); // passthrough
        overrides.put("reverb_year", "1965");          // passthrough
        overrides.put("ebay_category_id", "12345");    // passthrough

        PublishListingRequest req = resolver.resolve(buildProduct(1), listingWith(overrides));

        // Resolved key should NOT appear in extraParams
        assertThat(req.getExtraParams()).doesNotContainKey("price");

        // Passthrough keys should all be present
        assertThat(req.getExtraParams()).containsKey("reverb_model");
        assertThat(req.getExtraParams()).containsKey("reverb_year");
        assertThat(req.getExtraParams()).containsKey("ebay_category_id");
        assertThat(req.getExtraParams().get("reverb_model")).isEqualTo("Stratocaster");
    }

    @Test
    void extraParams_isEmpty_whenNoPassthroughKeys() {
        PublishListingRequest req = resolver.resolve(
            buildProduct(1),
            listingWith(Map.of("price", "400.00", "title", "Custom"))
        );
        assertThat(req.getExtraParams()).isEmpty();
    }

    // ── Shipping delegation ────────────────────────────────────────────────────

    @Test
    void shippingDetails_delegatedToShippingCalculator() {
        ShippingDetails expected = ShippingDetails.builder()
            .weightOz(new BigDecimal("96.0"))
            .build();
        when(shippingCalculator.resolveShipping(any(), any())).thenReturn(expected);

        Product product = buildProduct(1);
        MarketplaceListing listing = listingWith(Map.of());

        PublishListingRequest req = resolver.resolve(product, listing);

        assertThat(req.getShippingDetails()).isSameAs(expected);
        verify(shippingCalculator).resolveShipping(eq(product), any());
    }

    @Test
    void overrides_nullMap_treatedAsEmpty() {
        MarketplaceListing listing = listingWith(null);
        // Should not throw and should produce a valid request
        PublishListingRequest req = resolver.resolve(buildProduct(2), listing);
        assertThat(req.getQuantity()).isEqualTo(2);
        assertThat(req.getPriceOverride()).isNull();
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private Product buildProduct(int qty) {
        return Product.builder()
            .sku("TEST-001")
            .title("Test Guitar")
            .description("A fine instrument")
            .price(new BigDecimal("800.00"))
            .quantity(qty)
            .condition(ProductCondition.EXCELLENT)
            .imageUrls(List.of())
            .build();
    }

    private MarketplaceListing listingWith(Map<String, Object> overrides) {
        MarketplaceListing listing = MarketplaceListing.builder()
            .marketplaceType(MarketplaceType.REVERB)
            .errorCount(0)
            .build();
        if (overrides != null) {
            listing.setListingOverrides(new HashMap<>(overrides));
        }
        return listing;
    }
}
