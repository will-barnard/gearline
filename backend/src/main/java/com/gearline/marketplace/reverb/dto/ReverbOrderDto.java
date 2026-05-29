package com.gearline.marketplace.reverb.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.util.List;

@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class ReverbOrderDto {

    private String id;
    private String status;

    @JsonProperty("buyer_name")
    private String buyerName;

    @JsonProperty("buyer_id")
    private String buyerId;

    @JsonProperty("amount_product")
    private ReverbListingDto.ReverbPrice amountProduct;

    @JsonProperty("amount_tax")
    private ReverbListingDto.ReverbPrice amountTax;

    @JsonProperty("amount_shipping")
    private ReverbListingDto.ReverbPrice amountShipping;

    @JsonProperty("amount_total")
    private ReverbListingDto.ReverbPrice amountTotal;

    @JsonProperty("created_at")
    private String createdAt;

    @JsonProperty("shipping_address")
    private ReverbShippingAddress shippingAddress;

    @JsonProperty("order_bundle_id")
    private String orderBundleId;

    @JsonProperty("_links")
    private ReverbListingDto.ReverbLinks links;

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ReverbShippingAddress {
        private String name;
        private String street_address;
        private String extended_address;
        private String locality;
        private String region;

        @JsonProperty("postal_code")
        private String postalCode;

        @JsonProperty("country_code")
        private String countryCode;

        private String phone;
    }
}
