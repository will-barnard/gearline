package com.gearline.marketplace.reverb.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.util.List;

/**
 * Maps to Reverb's listing create/update API request/response schema.
 * https://reverb.com/api#listings
 */
@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class ReverbListingDto {

    private String id;
    private String title;
    private String description;

    @JsonProperty("make")
    private String make;

    @JsonProperty("model")
    private String model;

    private ReverbPrice price;

    @JsonProperty("inventory")
    private ReverbInventory inventory;

    @JsonProperty("condition")
    private ReverbCondition condition;

    @JsonProperty("categories")
    private List<ReverbCategory> categories;

    @JsonProperty("photos")
    private List<ReverbPhoto> photos;

    private String sku;
    private String slug;

    @JsonProperty("_links")
    private ReverbLinks links;

    private String state;

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ReverbPrice {
        private String amount;
        private String currency;

        @JsonProperty("amount_cents")
        private Integer amountCents;
    }

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ReverbInventory {
        private Integer total;
    }

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ReverbCondition {
        private String slug;
        private String display_name;
    }

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ReverbCategory {
        private String uuid;
        private String full_name;
    }

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ReverbPhoto {
        private String full;
        private String large;
        private String medium;
        private String small;
    }

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ReverbLinks {
        private ReverbLink self;
        private ReverbLink web;

        @JsonProperty("manage_url")
        private ReverbLink manageUrl;
    }

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ReverbLink {
        private String href;
    }
}
