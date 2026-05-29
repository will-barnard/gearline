package com.gearline.marketplace.shopify.client;

public class ShopifyApiException extends RuntimeException {
    public ShopifyApiException(String message, Throwable cause) {
        super(message, cause);
    }
}
