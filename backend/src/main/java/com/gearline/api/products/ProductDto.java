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
    ProductCondition condition,
    BigDecimal price,
    Integer quantity,
    BigDecimal weightKg,
    String serialNumber,
    List<String> imageUrls,
    String videoUrl,
    ProductStatus status,
    String shopifyProductId,
    Instant createdAt,
    Instant updatedAt
) {
    public static ProductDto from(Product p) {
        return new ProductDto(
            p.getId(), p.getSku(), p.getTitle(), p.getDescription(),
            p.getBrand(), p.getCategory(), p.getCondition(), p.getPrice(),
            p.getQuantity(), p.getWeightKg(), p.getSerialNumber(),
            p.getImageUrls(), p.getVideoUrl(), p.getStatus(), p.getShopifyProductId(),
            p.getCreatedAt(), p.getUpdatedAt()
        );
    }
}
