package com.gearline.api.products;

import com.gearline.domain.product.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record ProductDto(
    UUID id,
    String sku,
    String title,
    String description,
    String brand,
    String category,
    String model,
    String yearMade,
    String finish,
    ProductCondition condition,
    String conditionNotes,
    BigDecimal price,
    Integer quantity,
    BigDecimal weightKg,
    /** Package dimensions in inches. Null if not yet set (calculated shipping will be unavailable). */
    BigDecimal dimLengthIn,
    BigDecimal dimWidthIn,
    BigDecimal dimHeightIn,
    String serialNumber,
    List<String> imageUrls,
    String videoUrl,
    ProductStatus status,
    /**
     * When true, this product is suppressed from all external marketplace channels.
     * No listings will be created or restored for it regardless of Shopify status.
     */
    boolean marketplaceExcluded,
    String shopifyProductId,
    Instant createdAt,
    Instant updatedAt
) {
    public static ProductDto from(Product p) {
        Dimensions d = p.getDimensions();
        return new ProductDto(
            p.getId(), p.getSku(), p.getTitle(), p.getDescription(),
            p.getBrand(), p.getCategory(), p.getModel(), p.getYearMade(), p.getFinish(),
            p.getCondition(), p.getConditionNotes(), p.getPrice(), p.getQuantity(), p.getWeightKg(),
            d != null ? d.getLengthIn() : null,
            d != null ? d.getWidthIn()  : null,
            d != null ? d.getHeightIn() : null,
            p.getSerialNumber(), p.getImageUrls(), p.getVideoUrl(),
            p.getStatus(), p.isMarketplaceExcluded(), p.getShopifyProductId(),
            p.getCreatedAt(), p.getUpdatedAt()
        );
    }
}
