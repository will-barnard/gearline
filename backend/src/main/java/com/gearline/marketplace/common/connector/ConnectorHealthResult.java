package com.gearline.marketplace.common.connector;

import lombok.Builder;
import lombok.Value;

@Value
@Builder
public class ConnectorHealthResult {
    boolean healthy;
    String message;
    MarketplaceType marketplaceType;

    public static ConnectorHealthResult healthy(MarketplaceType type) {
        return ConnectorHealthResult.builder()
            .healthy(true)
            .message("OK")
            .marketplaceType(type)
            .build();
    }

    public static ConnectorHealthResult unhealthy(MarketplaceType type, String reason) {
        return ConnectorHealthResult.builder()
            .healthy(false)
            .message(reason)
            .marketplaceType(type)
            .build();
    }
}
