package com.gearline.marketplace.shopify.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.math.BigDecimal;
import java.util.List;

@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class ShopifyProductDto {

    private Long id;
    private String title;

    @JsonProperty("body_html")
    private String bodyHtml;

    private String vendor;

    @JsonProperty("product_type")
    private String productType;

    private String status;
    private List<Variant> variants;
    private List<Image> images;

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Variant {
        private Long id;
        private String sku;
        private BigDecimal price;

        @JsonProperty("inventory_quantity")
        private Integer inventoryQuantity;

        @JsonProperty("inventory_item_id")
        private Long inventoryItemId;

        private String condition;
        private Double grams;
    }

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Image {
        private Long id;
        private String src;
        private Integer position;
    }
}
