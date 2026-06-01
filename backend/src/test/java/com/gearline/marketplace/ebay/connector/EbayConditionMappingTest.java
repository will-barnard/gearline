package com.gearline.marketplace.ebay.connector;

import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductCondition;
import com.gearline.marketplace.common.dto.PublishListingRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.math.BigDecimal;
import java.util.Map;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Tests condition mapping and inventory item body construction in EbayConnector
 * without needing Spring context (all dependencies mocked or stubbed).
 *
 * The condition mapping is private, so it is exercised indirectly by capturing
 * the body passed to EbayApiClient.createOrUpdateInventoryItem().
 */
class EbayConditionMappingTest {

    @ParameterizedTest(name = "{0} → {1}")
    @MethodSource("conditionMappings")
    void conditionMapping_producesExpectedEbayValue(ProductCondition input, String expectedEbay) {
        Product product = Product.builder()
            .sku("TEST-SKU")
            .title("Test Product")
            .price(new BigDecimal("100.00"))
            .quantity(1)
            .condition(input)
            .build();

        PublishListingRequest request = PublishListingRequest.builder()
            .quantity(1)
            .build();

        // Invoke publishListing — it will call ensureValidToken then createOrUpdateInventoryItem.
        // EbayApiClient is mocked to throw, but we only need the condition value from the body.
        // Instead, we directly exercise via a spy approach: capture the body arg.
        // Since the private method is not accessible, we verify through behaviour:
        // we call the public method and capture what the mock received.

        var captor = org.mockito.ArgumentCaptor.forClass(Map.class);
        var apiClient = mock(com.gearline.marketplace.ebay.client.EbayApiClient.class);
        // Let createOrUpdateInventoryItem succeed; createOffer throw to short-circuit
        org.mockito.Mockito.doNothing().when(apiClient)
            .createOrUpdateInventoryItem(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), captor.capture());
        org.mockito.Mockito.when(apiClient.createOffer(
            org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
            .thenThrow(new com.gearline.marketplace.ebay.client.EbayApiException("test-stop", null));

        var authProvider = mock(EbayAuthProvider.class);
        when(authProvider.areCredentialsValid(org.mockito.ArgumentMatchers.any())).thenReturn(true);

        var account = mock(com.gearline.domain.marketplace.MarketplaceAccount.class);
        when(account.getEncryptedCredentials()).thenReturn(Map.of("access_token", "tok"));

        EbayConnector c = new EbayConnector(authProvider, apiClient, new EbayOrderMapper());
        c.publishListing(account, product, request);

        @SuppressWarnings("unchecked")
        Map<String, Object> body = captor.getValue();
        assertThat(body.get("condition")).isEqualTo(expectedEbay);
    }

    static Stream<Arguments> conditionMappings() {
        return Stream.of(
            Arguments.of(ProductCondition.NEW,        "NEW"),
            Arguments.of(ProductCondition.OPEN_BOX,   "NEW_OTHER"),
            Arguments.of(ProductCondition.MINT,       "LIKE_NEW"),
            Arguments.of(ProductCondition.EXCELLENT,  "LIKE_NEW"),
            Arguments.of(ProductCondition.VERY_GOOD,  "VERY_GOOD"),
            Arguments.of(ProductCondition.GOOD,       "GOOD"),
            Arguments.of(ProductCondition.FAIR,       "ACCEPTABLE"),
            Arguments.of(ProductCondition.USED,       "ACCEPTABLE"),
            Arguments.of(ProductCondition.POOR,       "FOR_PARTS_OR_NOT_WORKING"),
            Arguments.of(ProductCondition.FOR_PARTS,  "FOR_PARTS_OR_NOT_WORKING")
        );
    }

    @Test
    void inventoryItemBody_includesRequiredFields() {
        Product product = Product.builder()
            .sku("SKU-001")
            .title("Test Guitar")
            .description("A fine instrument")
            .price(new BigDecimal("999.00"))
            .quantity(2)
            .condition(ProductCondition.EXCELLENT)
            .build();

        var shipping = com.gearline.marketplace.common.dto.ShippingDetails.builder()
            .weightOz(new BigDecimal("96.0"))
            .lengthIn(new BigDecimal("48.0"))
            .widthIn(new BigDecimal("18.0"))
            .heightIn(new BigDecimal("6.0"))
            .build();

        PublishListingRequest request = PublishListingRequest.builder()
            .quantity(2)
            .shippingDetails(shipping)
            .build();

        var captor = org.mockito.ArgumentCaptor.forClass(Map.class);
        var apiClient = mock(com.gearline.marketplace.ebay.client.EbayApiClient.class);
        org.mockito.Mockito.doNothing().when(apiClient)
            .createOrUpdateInventoryItem(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), captor.capture());
        org.mockito.Mockito.when(apiClient.createOffer(
            org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
            .thenThrow(new com.gearline.marketplace.ebay.client.EbayApiException("stop", null));

        var authProvider = mock(EbayAuthProvider.class);
        when(authProvider.areCredentialsValid(org.mockito.ArgumentMatchers.any())).thenReturn(true);
        var account = mock(com.gearline.domain.marketplace.MarketplaceAccount.class);
        when(account.getEncryptedCredentials()).thenReturn(Map.of("access_token", "tok"));

        EbayConnector c = new EbayConnector(authProvider, apiClient, new EbayOrderMapper());
        c.publishListing(account, product, request);

        @SuppressWarnings("unchecked")
        Map<String, Object> body = captor.getValue();

        assertThat(body).containsKey("product");
        assertThat(body).containsKey("condition");
        assertThat(body).containsKey("availability");
        assertThat(body).containsKey("packageWeightAndSize");

        @SuppressWarnings("unchecked")
        Map<String, Object> productBlock = (Map<String, Object>) body.get("product");
        assertThat(productBlock.get("title")).isEqualTo("Test Guitar");
    }
}
