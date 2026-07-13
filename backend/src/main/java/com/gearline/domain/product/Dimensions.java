package com.gearline.domain.product;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import lombok.*;

import java.math.BigDecimal;

/**
 * Package dimensions in inches, used for calculated shipping on eBay and Reverb.
 * Synced from Shopify metafields: custom.dim_length_in, custom.dim_width_in, custom.dim_height_in.
 */
@Embeddable
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Dimensions {

    @Column(name = "dim_length_in", precision = 8, scale = 2)
    private BigDecimal lengthIn;

    @Column(name = "dim_width_in", precision = 8, scale = 2)
    private BigDecimal widthIn;

    @Column(name = "dim_height_in", precision = 8, scale = 2)
    private BigDecimal heightIn;
}
