import { loggerFor } from '../logger.js';
import { registerConnector, registeredTypes } from './registry.js';
import { reverbConnector } from './reverb/connector.js';
import { shopifyConnector } from './shopify/connector.js';
import { ebayConnector } from './ebay/connector.js';

const log = loggerFor('marketplace');

/**
 * Connector registration.
 *
 * Called once at startup. Each connector is registered explicitly — there is no
 * component scan, so this file is the definitive list of what the Node service
 * can talk to.
 *
 * ── Current state of the port ────────────────────────────────────────────────
 *
 * ALL THREE connectors are registered. The partial-port guard in
 * sync-job-consumer.ts is now dead code — harmless, and worth keeping until
 * Java is fully retired in case a connector has to be rolled back.
 *
 * The registry throwing "No connector registered for X" remains the intended
 * failure mode if a job somehow arrives for an unregistered marketplace: loud
 * and specific, rather than silently doing nothing.
 */
export function registerConnectors(): void {
  registerConnector(reverbConnector);
  registerConnector(shopifyConnector);
  registerConnector(ebayConnector);

  const types = registeredTypes();

  if (types.length === 0) {
    log.warn(
      'No marketplace connectors registered — all connector-backed work is still ' +
        'handled by the Java service. Sync jobs reaching this process will ' +
        'dead-letter. This is expected until the connector port lands.',
    );
    return;
  }

  log.info({ connectors: types }, 'Marketplace connectors registered');
}

export { getConnector, hasConnector, registeredTypes } from './registry.js';
export * from './types.js';
