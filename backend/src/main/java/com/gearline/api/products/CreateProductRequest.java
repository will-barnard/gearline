package com.gearline.api.products;

import com.gearline.domain.product.ProductCondition;
import jakarta.validation.constraints.*;

import java.math.BigDecimal;
import java.util.List;

public record CreateProductRequest(
    @NotBlank @Size(max = 100) String sku,
    @NotBlank @Size(max = 500) String title,
    String description,
    String brand,
    String category,
    @NotNull ProductCondition condition,
    @NotNull @DecimalMin("0.00") BigDecimal price,
    @Min(0) Integer quantity,
    BigDecimal weightKg,
    String serialNumber,
    List<String> imageUrls
) {}
