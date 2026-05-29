package com.gearline.domain.product;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import lombok.*;

import java.math.BigDecimal;

@Embeddable
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Dimensions {

    @Column(name = "dim_length_cm", precision = 8, scale = 2)
    private BigDecimal lengthCm;

    @Column(name = "dim_width_cm", precision = 8, scale = 2)
    private BigDecimal widthCm;

    @Column(name = "dim_height_cm", precision = 8, scale = 2)
    private BigDecimal heightCm;
}
