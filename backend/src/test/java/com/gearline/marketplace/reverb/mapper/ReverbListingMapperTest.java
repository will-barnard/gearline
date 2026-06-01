package com.gearline.marketplace.reverb.mapper;

import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.marketplace.common.dto.PublishListingRequest;
import com.gearline.marketplace.common.dto.ShippingDetails;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifies that ReverbListingMapper produces request bodies that match the
 * Reverb Create Listing API spec: https://www.reverb-api.com/docs/create-listings
 */
@SuppressWarnings("unchecked")
class ReverbListingMapperTest {

    private ReverbListingMapper mapper;

    @BeforeEach
    void setUp() {
        mapper = new ReverbListingMapper();
    }

    // ── Inventory ──────────────────────────────────────────────────────────────

    @Test
    void inventory_isFlatInteger_notNestedObject() {
        // Reverb API expects: "inventory": 3, "has_inventory": true
        // NOT: "inventory": {"total": 3}
        Map<String, Object> body = listingBody(buildProduct(), buildRequest(3));

        assertThat(body.get("inventory")).isEqualTo(3);
        assertThat(body.get("has_inventory")).isEqualTo(true);
        assertThat(body.get("inventory")).isNotInstanceOf(Map.class);
    }

    // ── Photos ────────────────────────────────────────────────────────────────

    @Test
    void photos_isArrayOfStrings_notArrayOfObjects() {
        // Reverb API expects: "photos": ["url1", "url2"]
        // NOT: "photos": [{"source": "url1"}]
        PublishListingRequest request = PublishListingRequest.builder()
            .quantity(1)
            .imageUrls(List.of("http://example.com/a.jpg", "http://example.com/b.jpg"))
            .build();

        Map<String, Object> body = listingBody(buildProduct(), request);
        List<?> photos = (List<?>) body.get("photos");

        assertThat(photos).isNotNull().hasSize(2);
        assertThat(photos.get(0)).isInstanceOf(String.class);
        assertThat(photos.get(0)).isEqualTo("http://example.com/a.jpg");
    }

    @Test
    void photos_absent_whenNoImageUrls() {
        Map<String, Object> body = listingBody(buildProduct(), buildRequest(1));
        assertThat(body).doesNotContainKey("photos");
    }

    // ── Make and model ────────────────────────────────────────────────────────

    @Test
    void make_sentFromProductBrand() {
        Map<String, Object> body = listingBody(buildProduct(), buildRequest(1));
        assertThat(body.get("make")).isEqualTo("Fender");
    }

    @Test
    void make_fallsBackToUnknown_whenBrandIsNull() {
        Product p = buildProduct().toBuilder().brand(null).build();
        Map<String, Object> body = listingBody(p, buildRequest(1));
        assertThat(body.get("make")).isEqualTo("Unknown");
    }

    @Test
    void model_sentFromExtraParams_whenPresent() {
        PublishListingRequest request = PublishListingRequest.builder()
            .quantity(1)
            .extraParams(Map.of("reverb_model", "Stratocaster"))
            .build();
        Map<String, Object> body = listingBody(buildProduct(), request);
        assertThat(body.get("model")).isEqualTo("Stratocaster");
    }

    @Test
    void model_fallsBackToCategory_whenNoExtraParam() {
        Product p = buildProduct().toBuilder().category("Electric Guitar").build();
        Map<String, Object> body = listingBody(p, buildRequest(1));
        assertThat(body.get("model")).isEqualTo("Electric Guitar");
    }

    @Test
    void model_fallsBackToTitle_whenNoCategoryOrExtraParam() {
        Product p = buildProduct().toBuilder().category(null).build();
        Map<String, Object> body = listingBody(p, buildRequest(1));
        assertThat(body.get("model")).isEqualTo("Test Guitar");
    }

    @Test
    void model_alwaysPresent() {
        // model must always be set — Reverb rejects listings without it
        Map<String, Object> body = listingBody(buildProduct(), buildRequest(1));
        assertThat(body).containsKey("model");
        assertThat(body.get("model")).isNotNull();
        assertThat((String) body.get("model")).isNotBlank();
    }

    // ── Shipping ──────────────────────────────────────────────────────────────

    @Test
    void shippingProfile_sentAsShippingProfileId_notName() {
        // Reverb API uses shipping_profile_id (numeric), not shipping_profile_name
        ShippingDetails shipping = ShippingDetails.builder()
            .shippingProfileName("456")  // stored as numeric ID
            .build();
        PublishListingRequest request = PublishListingRequest.builder()
            .quantity(1)
            .shippingDetails(shipping)
            .build();

        Map<String, Object> body = listingBody(buildProduct(), request);

        assertThat(body).containsKey("shipping_profile_id");
        assertThat(body.get("shipping_profile_id")).isEqualTo("456");
        assertThat(body).doesNotContainKey("shipping_profile_name");
    }

    @Test
    void weight_sentWhenNoProfile() {
        ShippingDetails shipping = ShippingDetails.builder()
            .weightOz(new BigDecimal("96.0"))
            .build();
        PublishListingRequest request = PublishListingRequest.builder()
            .quantity(1)
            .shippingDetails(shipping)
            .build();

        Map<String, Object> body = listingBody(buildProduct(), request);
        assertThat(body).containsKey("weight");
        Map<String, Object> weight = (Map<String, Object>) body.get("weight");
        assertThat(weight.get("unit")).isEqualTo("oz");
        assertThat(weight.get("value")).isEqualTo("96.0");
    }

    // ── Condition ────────────────────────────────────────────────────────────

    @Test
    void condition_sentAsSlugObject() {
        Map<String, Object> body = listingBody(buildProduct(), buildRequest(1));
        Map<String, Object> condition = (Map<String, Object>) body.get("condition");
        assertThat(condition).containsKey("slug");
        assertThat(condition.get("slug")).isEqualTo("excellent");
    }

    // ── Category ─────────────────────────────────────────────────────────────

    @Test
    void category_sentAsUuidArray_whenPresent() {
        PublishListingRequest request = PublishListingRequest.builder()
            .quantity(1)
            .categoryId("abc-uuid-123")
            .build();
        Map<String, Object> body = listingBody(buildProduct(), request);

        List<Map<String, Object>> categories = (List<Map<String, Object>>) body.get("categories");
        assertThat(categories).hasSize(1);
        assertThat(categories.get(0).get("uuid")).isEqualTo("abc-uuid-123");
    }

    // ── Price ─────────────────────────────────────────────────────────────────

    @Test
    void price_usesPriceOverride_whenSet() {
        PublishListingRequest request = buildRequest(1).toBuilder()
            .priceOverride(new BigDecimal("1299.00"))
            .build();
        Map<String, Object> body = listingBody(buildProduct(), request);
        Map<String, Object> price = (Map<String, Object>) body.get("price");
        assertThat(price.get("amount")).isEqualTo("1299.00");
        assertThat(price.get("currency")).isEqualTo("USD");
    }

    @Test
    void price_fallsBackToProductPrice_whenNoOverride() {
        Map<String, Object> body = listingBody(buildProduct(), buildRequest(1));
        Map<String, Object> price = (Map<String, Object>) body.get("price");
        assertThat(price.get("amount")).isEqualTo("800.00");
    }

    // ── Top-level wrapper ─────────────────────────────────────────────────────

    @Test
    void requestBody_wrappedInListingKey() {
        Map<String, Object> result = mapper.toReverbRequest(buildProduct(), buildRequest(1));
        assertThat(result).containsKey("listing");
        assertThat(result.get("listing")).isInstanceOf(Map.class);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private Map<String, Object> listingBody(Product product, PublishListingRequest request) {
        return (Map<String, Object>) mapper.toReverbRequest(product, request).get("listing");
    }

    private Product buildProduct() {
        return Product.builder()
            .sku("TEST-001")
            .title("Test Guitar")
            .description("A fine guitar")
            .brand("Fender")
            .category("Guitar")
            .price(new BigDecimal("800.00"))
            .quantity(5)
            .condition(ProductCondition.EXCELLENT)
            .build();
    }

    private PublishListingRequest buildRequest(int quantity) {
        return PublishListingRequest.builder()
            .quantity(quantity)
            .build();
    }
}
