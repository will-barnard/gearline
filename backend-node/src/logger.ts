import { pino } from 'pino';

import { config } from './config.js';

/**
 * Structured logger. Replaces SLF4J/Logback.
 *
 * In production we emit newline-delimited JSON, which is what `docker logs`
 * and Beachhead's log viewer handle best. In development we stay on JSON too
 * rather than pulling in pino-pretty as a dependency — pipe through
 * `npx pino-pretty` locally if you want colour.
 */
export const logger = pino({
  level: config.logLevel,
  base: { service: 'gearline-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-shopify-hmac-sha256"]',
      'password',
      '*.password',
      '*.accessToken',
      '*.refreshToken',
      '*.client_secret',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;

/** Child logger with a fixed component name, mirroring per-class Java loggers. */
export function loggerFor(component: string) {
  return logger.child({ component });
}
