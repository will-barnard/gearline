import type { MarketplaceType } from '../db/types.js';
import { loggerFor } from '../logger.js';
import type { MarketplaceConnector } from './types.js';

const log = loggerFor('connector-registry');

/**
 * Resolves a connector by marketplace type.
 *
 * Java discovered these through Spring's component scan. There is no DI
 * container here, so connectors register explicitly at startup. That is more
 * verbose but has a real advantage: an unregistered connector is a visible
 * omission in one file rather than a missing annotation nobody notices until a
 * job fails in production.
 */
const connectors = new Map<MarketplaceType, MarketplaceConnector>();

export function registerConnector(connector: MarketplaceConnector): void {
  if (connectors.has(connector.marketplaceType)) {
    throw new Error(`Connector already registered for ${connector.marketplaceType}`);
  }
  connectors.set(connector.marketplaceType, connector);
  log.info({ marketplace: connector.marketplaceType }, 'Registered marketplace connector');
}

export function hasConnector(type: MarketplaceType): boolean {
  return connectors.has(type);
}

/**
 * Throws when no connector is registered. This is a programming error, not a
 * user error — the same contract the Java registry had.
 */
export function getConnector(type: MarketplaceType): MarketplaceConnector {
  const connector = connectors.get(type);
  if (!connector) {
    throw new Error(
      `No connector registered for marketplace type: ${type}. ` +
        'Check src/marketplace/index.ts registers it at startup.',
    );
  }
  return connector;
}

export function registeredTypes(): MarketplaceType[] {
  return [...connectors.keys()];
}

/** Test seam. */
export function __clearRegistry(): void {
  connectors.clear();
}
