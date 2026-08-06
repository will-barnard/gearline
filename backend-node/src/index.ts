import type { Server } from 'node:http';

import { createApp } from './app.js';
import { config } from './config.js';
import { closeDatabase, verifyDatabase } from './db/index.js';
import { logger } from './logger.js';
import { startQueue, stopQueue } from './queue/boss.js';
import { startRetryScheduler, stopRetryScheduler } from './queue/retry-scheduler.js';
import { startConsumer } from './queue/sync-job-consumer.js';
import { startOrderPolling, stopOrderPolling } from './services/order-polling.js';
import { registerConnectors, registeredTypes } from './marketplace/index.js';
import { ensureBootstrapAdmin } from './bootstrap/admin.js';

/**
 * Process entrypoint.
 *
 * Startup order matters: verify the database first so a schema or connectivity
 * problem fails immediately with a clear message, rather than surfacing later
 * as a confusing error inside a request handler.
 */
async function main(): Promise<void> {
  await verifyDatabase();
  await ensureBootstrapAdmin();

  registerConnectors();
  await startQueue();

  /**
   * The consumer and retry scheduler only run once at least one connector is
   * registered.
   *
   * This guard matters during the strangler cutover. Both backends share the
   * database, and the Java service is still consuming from RabbitMQ. If Node
   * started consuming from pg-boss with no connectors, every job it picked up
   * would immediately dead-letter — turning a working system into a pile of
   * failed jobs. Staying idle means jobs simply queue until either a connector
   * lands here or the Java service handles them.
   */
  if (registeredTypes().length > 0) {
    await startConsumer();
    startRetryScheduler();
    startOrderPolling();
  } else {
    logger.warn(
      'Sync job consumer NOT started — no connectors registered. Sync jobs remain ' +
        "the Java service's responsibility. Enqueued jobs will wait rather than fail.",
    );
  }

  const app = createApp();

  const server: Server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'Gearline backend listening');
  });

  /**
   * Node's default keep-alive timeout (5s) is shorter than nginx's (75s), which
   * produces sporadic 502s: nginx reuses a connection at the same moment Node
   * closes it. Setting ours above nginx's makes the proxy always the side that
   * closes first. headersTimeout must exceed keepAliveTimeout or Node will
   * reject slow-header requests.
   */
  server.keepAliveTimeout = 90_000;
  server.headersTimeout = 95_000;

  setupGracefulShutdown(server);
}

/**
 * Graceful shutdown.
 *
 * Beachhead's blue/green swap sends SIGTERM and then waits before killing the
 * container. Draining properly here is what makes a deploy invisible to users:
 * in-flight HTTP requests finish, and in-flight sync jobs finish rather than
 * being torn off mid-call to a marketplace API — which for a publish or delist
 * could leave a listing in an inconsistent state on eBay or Reverb.
 */
function setupGracefulShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Hard deadline. If draining has not finished in 30s something is wedged
    // and exiting non-zero is better than hanging until the orchestrator SIGKILLs.
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 30s — forcing exit');
      process.exit(1);
    }, 30_000);
    forceExit.unref();

    server.close(() => {
      void (async () => {
        try {
          stopRetryScheduler();
          stopOrderPolling();
          await stopQueue(); // waits for in-flight job handlers
          await closeDatabase();
          clearTimeout(forceExit);
          logger.info('Shutdown complete');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Error during shutdown');
          process.exit(1);
        }
      })();
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  /**
   * An unhandled rejection leaves the process in an unknown state. Log it and
   * exit so the orchestrator restarts a clean one — silently continuing risks
   * processing marketplace jobs with corrupted state.
   */
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection — exiting');
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
