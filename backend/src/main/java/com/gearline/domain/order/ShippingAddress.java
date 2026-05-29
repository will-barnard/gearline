package com.gearline.domain.order;

import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ShippingAddress {
    private String line1;
    private String line2;
    private String city;
    private String state;
    private String postalCode;
    private String country;
}
