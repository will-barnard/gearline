package com.gearline.api.products;

import com.gearline.domain.product.ProductCondition;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Min;

import java.math.BigDecimal;
import java.util.List;

public record UpdateProductRequest(
    String sku,
    String title,
    String description,
    String brand,
    String category,
    ProductCondition condition,
    @DecimalMin("0.00") BigDecimal price,
    @Min(0) Integer quantity,
    List<String> imageUrls,
    String videoUrl
) {}
