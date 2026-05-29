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

    /**
     * The listing that was sold.
     * Reverb orders are always single-item; the item detail lives here.
     * Reverb API field: "listing"
     */
    private ReverbOrderListing listing;

    /** Quantity sold — almost always 1 on Reverb, but captured for correctness */
    private Integer quantity;

    /** Buyer email — present on orders where the buyer has allowed contact */
    @JsonProperty("buyer_email")
    private String buyerEmail;

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ReverbOrderListing {
        /** Reverb's internal listing ID */
        private String id;

        /** Seller SKU — maps back to our Product.sku */
        private String sku;

        private String title;

        /** Reverb's own slug-based listing URL */
        @JsonProperty("_links")
        private ReverbListingDto.ReverbLinks links;
    }

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
