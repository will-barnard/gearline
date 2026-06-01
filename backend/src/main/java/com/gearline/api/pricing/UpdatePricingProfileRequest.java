package com.gearline.api.pricing;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;

import java.math.BigDecimal;

public record UpdatePricingProfileRequest(
    String name,
    @DecimalMin("-100") @DecimalMax("1000") BigDecimal adjustmentPercent,
    Boolean active
) {}
