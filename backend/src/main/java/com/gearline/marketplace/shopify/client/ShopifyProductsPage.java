package com.gearline.marketplace.shopify.client;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * Wraps a single page of results from the Shopify products list endpoint.
 * {@code nextPageInfo} is non-null when there are more pages; pass it as the
 * {@code pageInfo} argument to the next {@link ShopifyApiClient#fetchProducts} call.
 */
public record ShopifyProductsPage(List<JsonNode> products, String nextPageInfo) {

    public boolean hasNextPage() {
        return nextPageInfo != null && !nextPageInfo.isBlank();
    }
}
