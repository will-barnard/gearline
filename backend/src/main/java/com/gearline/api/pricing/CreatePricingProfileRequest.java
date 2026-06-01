package com.gearline.api.pricing;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.math.BigDecimal;

public record CreatePricingProfileRequest(
    @NotBlank String name,
    @NotNull @DecimalMin("-100") @DecimalMax("1000") BigDecimal adjustmentPercent
) {}
