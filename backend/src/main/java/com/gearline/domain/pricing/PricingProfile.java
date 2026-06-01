package com.gearline.domain.pricing;

import com.gearline.domain.audit.AuditableEntity;
import jakarta.persistence.*;
import lombok.*;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * A named pricing rule applied to a marketplace account at sync time.
 *
 * The adjustment is a percentage relative to the canonical {@code product.price}:
 *   finalPrice = product.price × (1 + adjustmentPercent / 100)
 *   rounded to 2 decimal places (HALF_UP).
 *
 * Examples:
 *   adjustmentPercent =  5.0  → list 5% above product price
 *   adjustmentPercent = -3.5  → list 3.5% below product price
 *   adjustmentPercent =  0.0  → list at product price (identity)
 *
 * An explicit listing_override price on the MarketplaceListing always takes
 * precedence over this profile.
 */
@Entity
@Table(name = "pricing_profiles")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
@EqualsAndHashCode(of = "id", callSuper = false)
public class PricingProfile extends AuditableEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(nullable = false, length = 200)
    private String name;

    /**
     * Percentage adjustment. Positive = markup, negative = markdown.
     * Stored with 4dp precision to support fractional percentages like 2.5%.
     */
    @Column(name = "adjustment_percent", nullable = false, precision = 7, scale = 4)
    private BigDecimal adjustmentPercent;

    @Column(nullable = false)
    @Builder.Default
    private Boolean active = true;
}
