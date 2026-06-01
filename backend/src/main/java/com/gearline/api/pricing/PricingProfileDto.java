package com.gearline.api.pricing;

import com.gearline.domain.pricing.PricingProfile;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public record PricingProfileDto(
    UUID id,
    String name,
    BigDecimal adjustmentPercent,
    Boolean active,
    Instant createdAt,
    Instant updatedAt
) {
    public static PricingProfileDto from(PricingProfile p) {
        return new PricingProfileDto(
            p.getId(), p.getName(), p.getAdjustmentPercent(),
            p.getActive(), p.getCreatedAt(), p.getUpdatedAt()
        );
    }
}
