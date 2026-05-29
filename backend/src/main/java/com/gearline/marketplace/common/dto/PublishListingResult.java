package com.gearline.marketplace.common.dto;

import lombok.Builder;
import lombok.Value;

import java.math.BigDecimal;
import java.util.Map;

@Value
@Builder
public class PublishListingResult {
    boolean success;
    String externalListingId;
    BigDecimal publishedPrice;
    Integer publishedQuantity;
    String errorMessage;
    Map<String, Object> rawMetadata;

    public static PublishListingResult success(String externalId, BigDecimal price, int qty, Map<String, Object> metadata) {
        return PublishListingResult.builder()
            .success(true)
            .externalListingId(externalId)
            .publishedPrice(price)
            .publishedQuantity(qty)
            .rawMetadata(metadata)
            .build();
    }

    public static PublishListingResult failure(String errorMessage) {
        return PublishListingResult.builder()
            .success(false)
            .errorMessage(errorMessage)
            .build();
    }
}
