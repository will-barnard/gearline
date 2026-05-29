package com.gearline.domain.sync;

public enum SyncJobType {
    // Inventory
    INVENTORY_SYNC,
    INVENTORY_PUSH_ALL,

    // Listings
    LISTING_PUBLISH,
    LISTING_UPDATE,
    LISTING_DELIST,
    LISTING_BULK_PUBLISH,
    LISTING_BULK_REPRICE,

    // Orders
    ORDER_IMPORT,
    ORDER_IMPORT_ALL,

    // Shopify
    SHOPIFY_PRODUCT_SYNC,
    SHOPIFY_INVENTORY_UPDATE,
    SHOPIFY_ORDER_SYNC,

    // Marketplace health
    MARKETPLACE_HEALTH_CHECK
}
