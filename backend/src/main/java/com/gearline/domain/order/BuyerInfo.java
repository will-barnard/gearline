package com.gearline.domain.order;

import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class BuyerInfo {
    private String externalBuyerId;
    private String username;
    private String email;
    private String firstName;
    private String lastName;
    private String phone;
}
