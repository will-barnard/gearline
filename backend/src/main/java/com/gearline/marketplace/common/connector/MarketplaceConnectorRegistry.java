package com.gearline.marketplace.common.connector;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Registry that holds all registered MarketplaceConnector implementations.
 * Connectors are discovered via Spring's dependency injection — any bean implementing
 * MarketplaceConnector is automatically registered here.
 *
 * Usage:
 *   MarketplaceConnector connector = registry.getConnector(MarketplaceType.REVERB);
 */
@Component
@Slf4j
public class MarketplaceConnectorRegistry {

    private final Map<MarketplaceType, MarketplaceConnector> connectors;

    public MarketplaceConnectorRegistry(List<MarketplaceConnector> connectorList) {
        this.connectors = connectorList.stream()
            .collect(Collectors.toMap(MarketplaceConnector::getMarketplaceType, Function.identity()));
        log.info("Registered {} marketplace connectors: {}", connectors.size(), connectors.keySet());
    }

    /**
     * Returns the connector for the given marketplace type.
     * Throws if no connector is registered (this is a programming error, not a user error).
     */
    public MarketplaceConnector getConnector(MarketplaceType type) {
        MarketplaceConnector connector = connectors.get(type);
        if (connector == null) {
            throw new IllegalStateException("No connector registered for marketplace type: " + type);
        }
        return connector;
    }

    public boolean hasConnector(MarketplaceType type) {
        return connectors.containsKey(type);
    }
}
