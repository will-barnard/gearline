package com.gearline.marketplace.common.dto;

import lombok.Builder;
import lombok.Value;

@Value
@Builder
public class InventorySyncResult {
    boolean success;
    int quantitySynced;
    String errorMessage;

    public static InventorySyncResult success(int quantity) {
        return InventorySyncResult.builder().success(true).quantitySynced(quantity).build();
    }

    public static InventorySyncResult failure(String error) {
        return InventorySyncResult.builder().success(false).errorMessage(error).build();
    }
}
